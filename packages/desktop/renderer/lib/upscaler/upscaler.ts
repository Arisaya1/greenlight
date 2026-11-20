// Real-time luma upscaler for the stream <video>, running mpv user shaders
// (FSRCNNX, ArtCNN, ...) through WebGL2 on a canvas laid over the video.
import { parseMpvShader, compilePass, evalRpn, CompiledPass, TexLayout } from './mpvshader'

export interface UpscalerSettings {
    shader: string // file name in /shaders, or 'off'
    mode: 'auto' | 'always' // auto = respect the shader's WHEN (only when actually upscaling)
    scaler: 'catmull' | 'bilinear' // final resample of the upscaled luma to screen size
    stats: boolean
}

export const SHADERS: { file: string; label: string; note: string }[] = [
    // frame costs measured on a GTX 1070 (WebGL2/ANGLE)
    { file: 'FSRCNNX_x2_8-0-4-1.glsl', label: 'FSRCNNX x2 8-0-4-1', note: '~12 ms/frame on a 720p stream, ~24 ms on 1080p' },
    { file: 'ArtCNN_C4F16.glsl', label: 'ArtCNN C4F16', note: 'Sharper. ~16 ms on 720p, ~38 ms on 1080p' },
    { file: 'ArtCNN_C4F32.glsl', label: 'ArtCNN C4F32', note: 'Best, ~57 ms on 720p. Not 60 fps on a 1070' },
]

export const DEFAULT_SETTINGS: UpscalerSettings = { shader: 'off', mode: 'auto', scaler: 'catmull', stats: false }
const STORAGE_KEY = 'greenlight.upscaler'

export function loadSettings(): UpscalerSettings {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }
    } catch {
        return { ...DEFAULT_SETTINGS }
    }
}
export function saveSettings(s: UpscalerSettings) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

export interface UpscalerStatus {
    active: boolean // shader passes ran on the last frame
    loading: boolean // shader still compiling
    error: string | null
    inSize: [number, number]
    outSize: [number, number]
    fps: number
    gpuMs: number | null
}

const VS = `#version 300 es
in vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`

const LUMA_FS = `#version 300 es
precision highp float;
uniform sampler2D src;
out vec4 o;
void main() {
    vec3 c = texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb;
    o = vec4(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 0.0, 1.0);
}`

// Recombine: chroma from bilinear source, luma from the upscaled plane.
const COMPOSE_FS = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform sampler2D luma;
uniform vec2 lumaSize;
uniform vec4 rect;
uniform int useLuma;
uniform int catmull;
out vec4 o;
float lumaCatmull(vec2 uv) {
    vec2 p = uv * lumaSize - 0.5;
    vec2 f = fract(p);
    vec2 c = (floor(p) + 0.5) / lumaSize;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 t = 1.0 / lumaSize;
    vec2 p0 = c - t, p3 = c + 2.0 * t, p12 = c + w2 / w12 * t;
    float r = 0.0;
    r += texture(luma, vec2(p0.x, p0.y)).r * w0.x * w0.y;
    r += texture(luma, vec2(p12.x, p0.y)).r * w12.x * w0.y;
    r += texture(luma, vec2(p3.x, p0.y)).r * w3.x * w0.y;
    r += texture(luma, vec2(p0.x, p12.y)).r * w0.x * w12.y;
    r += texture(luma, vec2(p12.x, p12.y)).r * w12.x * w12.y;
    r += texture(luma, vec2(p3.x, p12.y)).r * w3.x * w12.y;
    r += texture(luma, vec2(p0.x, p3.y)).r * w0.x * w3.y;
    r += texture(luma, vec2(p12.x, p3.y)).r * w12.x * w3.y;
    r += texture(luma, vec2(p3.x, p3.y)).r * w3.x * w3.y;
    return r;
}
void main() {
    vec2 uv = (gl_FragCoord.xy - rect.xy) / rect.zw;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
    uv.y = 1.0 - uv.y;
    vec3 rgb = texture(src, uv).rgb;
    if (useLuma == 1) {
        float yLo = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        float yHi = catmull == 1 ? lumaCatmull(uv) : texture(luma, uv).r;
        rgb += clamp(yHi, 0.0, 1.0) - yLo;
    }
    o = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`

interface Target { fbo: WebGLFramebuffer; texs: WebGLTexture[]; w: number; h: number }
interface Prog { prog: WebGLProgram; loc: Record<string, WebGLUniformLocation | null> }

export class Upscaler {
    private gl: WebGL2RenderingContext
    private canvas: HTMLCanvasElement
    private video: HTMLVideoElement | HTMLImageElement
    private settings: UpscalerSettings
    private vbo: WebGLBuffer
    private srcTex: WebGLTexture
    private lumaProg: Prog
    private composeProg: Prog
    private passes: CompiledPass[] = []
    private passProgs: Prog[] = []
    private targets: (Target | null)[] = []
    private lumaTarget: Target | null = null
    private loadToken = 0
    private rvfc = 0
    private ro: ResizeObserver
    private destroyed = false
    private timerExt: any
    private queries: WebGLQuery[] = []
    private frames = 0
    private fpsT0 = performance.now()
    status: UpscalerStatus = { active: false, loading: false, error: null, inSize: [0, 0], outSize: [0, 0], fps: 0, gpuMs: null }
    onStatus: ((s: UpscalerStatus) => void) | null = null
    outputOverride: [number, number] | null = null // tests: fixed canvas size

    constructor(video: HTMLVideoElement | HTMLImageElement, settings: UpscalerSettings) {
        this.video = video
        this.settings = settings
        const canvas = document.createElement('canvas')
        canvas.id = 'component_streamcomponent_upscaler'
        Object.assign(canvas.style, {
            position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
            pointerEvents: 'none', zIndex: '96', display: 'none',
        })
        video.parentElement.style.position = video.parentElement.style.position || 'fixed'
        video.parentElement.appendChild(canvas)
        this.canvas = canvas
        const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, desynchronized: true, powerPreference: 'high-performance' })
        if (!gl) throw new Error('WebGL2 not available')
        if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
            throw new Error('float render targets not supported')
        }
        this.gl = gl
        this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2')
        this.vbo = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
        this.srcTex = this.makeTex(gl.RGBA8, 1, 1, gl.LINEAR)
        this.lumaProg = this.link(LUMA_FS)
        this.composeProg = this.link(COMPOSE_FS)
        this.ro = new ResizeObserver(() => this.render())
        this.ro.observe(video)
        if (video instanceof HTMLVideoElement) {
            const loop = () => {
                if (this.destroyed) return
                this.rvfc = video.requestVideoFrameCallback(loop)
                this.render()
            }
            this.rvfc = video.requestVideoFrameCallback(loop)
        }
        this.apply(settings)
    }

    async apply(settings: UpscalerSettings) {
        const prev = this.settings.shader
        this.settings = { ...settings }
        if (settings.shader !== prev || this.passes.length === 0) {
            const token = ++this.loadToken
            this.freePasses()
            this.status.error = null
            if (settings.shader !== 'off') {
                try {
                    const src = await (await fetch('/shaders/' + settings.shader)).text()
                    if (token !== this.loadToken) return
                    this.status.loading = true
                    this.emit(true)
                    const ok = await this.buildPasses(src, token)
                    if (!ok) return
                    this.status.loading = false
                } catch (e) {
                    if (token !== this.loadToken) return
                    console.error('[upscaler] failed to load', settings.shader, e)
                    this.status.error = String(e && e.message || e)
                    this.status.loading = false
                    this.freePasses()
                }
            }
        }
        this.render()
        this.emit(true)
    }

    destroy() {
        this.destroyed = true
        if (this.video instanceof HTMLVideoElement) this.video.cancelVideoFrameCallback(this.rvfc)
        this.ro.disconnect()
        this.freePasses()
        const lose = this.gl.getExtension('WEBGL_lose_context')
        if (lose) lose.loseContext()
        this.canvas.remove()
    }

    // ---------- GL helpers ----------
    private makeTex(fmt: number, w: number, h: number, filter: number): WebGLTexture {
        const gl = this.gl
        const t = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, t)
        if (fmt === gl.RGBA8) gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        else gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        return t
    }

    private makeTarget(w: number, h: number, n: number, filter: number): Target {
        const gl = this.gl
        const fbo = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        const texs: WebGLTexture[] = []
        const bufs: number[] = []
        for (let k = 0; k < n; k++) {
            const t = this.makeTex(gl.RGBA16F, w, h, filter)
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0)
            texs.push(t); bufs.push(gl.COLOR_ATTACHMENT0 + k)
        }
        gl.drawBuffers(bufs)
        const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
        if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete: 0x' + st.toString(16))
        return { fbo, texs, w, h }
    }

    private freeTarget(t: Target | null) {
        if (!t) return
        t.texs.forEach(x => this.gl.deleteTexture(x))
        this.gl.deleteFramebuffer(t.fbo)
    }

    // Compile without blocking the page (big CNN shaders take seconds in ANGLE).
    private async linkAsync(fs: string): Promise<Prog> {
        const gl = this.gl
        const ext = gl.getExtension('KHR_parallel_shader_compile')
        const prog = gl.createProgram()
        const v = gl.createShader(gl.VERTEX_SHADER), f = gl.createShader(gl.FRAGMENT_SHADER)
        gl.shaderSource(v, VS); gl.compileShader(v)
        gl.shaderSource(f, fs); gl.compileShader(f)
        gl.attachShader(prog, v); gl.attachShader(prog, f)
        gl.bindAttribLocation(prog, 0, 'a')
        gl.linkProgram(prog)
        if (ext) {
            while (!gl.getProgramParameter(prog, ext.COMPLETION_STATUS_KHR)) {
                await new Promise(r => setTimeout(r, 50))
                if (this.destroyed) throw new Error('destroyed')
            }
        }
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            const log = gl.getShaderInfoLog(f) || gl.getProgramInfoLog(prog)
            gl.deleteProgram(prog); gl.deleteShader(v); gl.deleteShader(f)
            throw new Error('shader compile failed: ' + log)
        }
        gl.deleteShader(v); gl.deleteShader(f)
        return { prog, loc: this.uniforms(prog) }
    }

    private uniforms(prog: WebGLProgram) {
        const gl = this.gl
        const loc: Record<string, WebGLUniformLocation | null> = {}
        const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)
        for (let i = 0; i < n; i++) {
            const name = gl.getActiveUniform(prog, i).name
            loc[name] = gl.getUniformLocation(prog, name)
        }
        return loc
    }

    private link(fs: string): Prog {
        const gl = this.gl
        const mk = (type: number, src: string) => {
            const s = gl.createShader(type)
            gl.shaderSource(s, src)
            gl.compileShader(s)
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(s)
                gl.deleteShader(s)
                throw new Error('shader compile failed: ' + log)
            }
            return s
        }
        const prog = gl.createProgram()
        const v = mk(gl.VERTEX_SHADER, VS), f = mk(gl.FRAGMENT_SHADER, fs)
        gl.attachShader(prog, v); gl.attachShader(prog, f)
        gl.bindAttribLocation(prog, 0, 'a')
        gl.linkProgram(prog)
        gl.deleteShader(v); gl.deleteShader(f)
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link failed: ' + gl.getProgramInfoLog(prog))
        return { prog, loc: this.uniforms(prog) }
    }

    // Returns false if superseded by a newer apply() while compiling.
    private async buildPasses(src: string, token: number): Promise<boolean> {
        const parsed = parseMpvShader(src).filter(p => p.hook === 'LUMA')
        if (!parsed.length) throw new Error('no LUMA hook passes in shader')
        const layouts: Record<string, TexLayout> = {}
        const compiled: CompiledPass[] = []
        for (const p of parsed) {
            const c = compilePass(p, layouts)
            if (c.outLayout.sx * c.outLayout.sy > this.gl.getParameter(this.gl.MAX_DRAW_BUFFERS)) {
                throw new Error('shader needs more render targets than this GPU allows')
            }
            layouts[p.save || p.hook] = c.outLayout
            compiled.push(c)
        }
        const t0 = performance.now()
        const progs = await Promise.all(compiled.map(c => this.linkAsync(c.fs)))
        if (token !== this.loadToken) {
            progs.forEach(p => this.gl.deleteProgram(p.prog))
            return false
        }
        this.passes = compiled
        this.passProgs = progs
        this.targets = compiled.map(() => null)
        console.log(`[upscaler] loaded ${this.settings.shader}: ${parsed.length} passes, compiled in ${Math.round(performance.now() - t0)}ms`)
        return true
    }

    private freePasses() {
        this.passProgs.forEach(p => this.gl.deleteProgram(p.prog))
        this.targets.forEach(t => this.freeTarget(t))
        this.passes = []; this.passProgs = []; this.targets = []
    }

    private draw() {
        const gl = this.gl
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
        gl.enableVertexAttribArray(0)
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    // Rect the video content occupies inside the element, honouring object-fit.
    private contentRect(cw: number, ch: number, vw: number, vh: number): [number, number, number, number] {
        const fit = getComputedStyle(this.video).objectFit
        if (fit === 'fill') return [0, 0, cw, ch]
        const s = fit === 'cover' ? Math.max(cw / vw, ch / vh) : Math.min(cw / vw, ch / vh)
        const w = Math.round(vw * s), h = Math.round(vh * s)
        return [Math.floor((cw - w) / 2), Math.floor((ch - h) / 2), w, h]
    }

    render() {
        if (this.destroyed) return
        const gl = this.gl, v = this.video
        const vw = v instanceof HTMLVideoElement ? v.videoWidth : v.naturalWidth
        const vh = v instanceof HTMLVideoElement ? v.videoHeight : v.naturalHeight
        const off = this.settings.shader === 'off' || this.status.error !== null
        if (off || !vw || !vh || gl.isContextLost()) {
            this.canvas.style.display = 'none'
            this.status.active = false
            this.emit()
            return
        }
        const dpr = window.devicePixelRatio || 1
        const [cw, ch] = this.outputOverride || [Math.max(1, Math.round(v.clientWidth * dpr)), Math.max(1, Math.round(v.clientHeight * dpr))]
        if (this.canvas.width !== cw || this.canvas.height !== ch) {
            this.canvas.width = cw; this.canvas.height = ch
        }
        const rect = this.contentRect(cw, ch, vw, vh)

        let q: WebGLQuery | null = null
        if (this.timerExt && this.queries.length < 4) {
            q = gl.createQuery()
            gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q)
        }

        // upload frame
        gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v)

        // luma plane
        if (!this.lumaTarget || this.lumaTarget.w !== vw || this.lumaTarget.h !== vh) {
            this.freeTarget(this.lumaTarget)
            this.lumaTarget = this.makeTarget(vw, vh, 1, gl.LINEAR)
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.lumaTarget.fbo)
        gl.viewport(0, 0, vw, vh)
        gl.useProgram(this.lumaProg.prog)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
        gl.uniform1i(this.lumaProg.loc.src, 0)
        this.draw()

        // shader passes
        const texMap: Record<string, Target> = { LUMA: this.lumaTarget }
        const sizes: Record<string, [number, number]> = { LUMA: [vw, vh], HOOKED: [vw, vh], NATIVE_CROPPED: [vw, vh], OUTPUT: [rect[2], rect[3]] }
        let ran = false
        for (let i = 0; i < this.passes.length; i++) {
            const c = this.passes[i], p = c.pass, prog = this.passProgs[i]
            if (this.settings.mode === 'auto' && p.when && !evalRpn(p.when, sizes)) continue
            const hs = sizes[p.hook]
            sizes.HOOKED = hs
            const dw = Math.round(p.width ? evalRpn(p.width, sizes) : hs[0])
            const dh = Math.round(p.height ? evalRpn(p.height, sizes) : hs[1])
            const { sx, sy } = c.outLayout
            const rw = Math.ceil(dw / sx), rh = Math.ceil(dh / sy)
            let t = this.targets[i]
            if (!t || t.w !== rw || t.h !== rh) {
                this.freeTarget(t)
                t = this.targets[i] = this.makeTarget(rw, rh, sx * sy, gl.LINEAR)
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
            gl.viewport(0, 0, rw, rh)
            gl.useProgram(prog.prog)
            gl.uniform2f(prog.loc.OUT_size, rw, rh)
            c.samplers.forEach(([uname, tex, k], unit) => {
                const src = texMap[tex]
                gl.activeTexture(gl.TEXTURE0 + unit)
                gl.bindTexture(gl.TEXTURE_2D, src ? src.texs[k] : null)
                if (prog.loc[uname]) gl.uniform1i(prog.loc[uname], unit)
            })
            for (const tex of c.sizeTex) {
                const s = sizes[tex]
                if (!s) continue
                if (prog.loc[tex + '_size']) gl.uniform2f(prog.loc[tex + '_size'], s[0], s[1])
                if (prog.loc[tex + '_pt']) gl.uniform2f(prog.loc[tex + '_pt'], 1 / s[0], 1 / s[1])
            }
            this.draw()
            const name = p.save || p.hook
            texMap[name] = t
            sizes[name] = [dw, dh]
            ran = true
        }
        for (let u = 0; u < 8; u++) {
            gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null)
        }

        // compose to screen
        const lumaOut = texMap.LUMA
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, cw, ch)
        const cp = this.composeProg
        gl.useProgram(cp.prog)
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.srcTex)
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lumaOut.texs[0])
        gl.uniform1i(cp.loc.src, 0)
        gl.uniform1i(cp.loc.luma, 1)
        gl.uniform2f(cp.loc.lumaSize, lumaOut.w, lumaOut.h)
        gl.uniform4f(cp.loc.rect, rect[0], ch - rect[1] - rect[3], rect[2], rect[3])
        gl.uniform1i(cp.loc.useLuma, ran ? 1 : 0)
        gl.uniform1i(cp.loc.catmull, this.settings.scaler === 'catmull' ? 1 : 0)
        this.draw()

        if (q) {
            gl.endQuery(this.timerExt.TIME_ELAPSED_EXT)
            this.queries.push(q)
        }
        this.pollQueries()

        this.canvas.style.display = 'block'
        this.frames++
        const now = performance.now()
        if (now - this.fpsT0 >= 1000) {
            this.status.fps = Math.round(this.frames * 1000 / (now - this.fpsT0))
            this.frames = 0; this.fpsT0 = now
        }
        this.status.active = ran
        this.status.inSize = [vw, vh]
        this.status.outSize = [rect[2], rect[3]]
        this.emit()
    }

    private pollQueries() {
        const gl = this.gl
        if (!this.timerExt) return
        while (this.queries.length) {
            const q = this.queries[0]
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
            this.queries.shift()
            if (!gl.getParameter(this.timerExt.GPU_DISJOINT_EXT)) {
                const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
                this.status.gpuMs = this.status.gpuMs === null ? ms : this.status.gpuMs * 0.9 + ms * 0.1
            }
            gl.deleteQuery(q)
        }
    }

    private lastEmit = 0
    private emit(force = false) {
        const now = performance.now()
        if (this.onStatus && (force || now - this.lastEmit > 500)) {
            this.lastEmit = now
            this.onStatus({ ...this.status })
        }
    }
}
