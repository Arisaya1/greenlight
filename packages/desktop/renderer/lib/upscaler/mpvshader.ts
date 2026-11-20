// Parser + WebGL2 translator for mpv/libplacebo user shaders (.glsl hooks).
// Supports fragment hooks (FSRCNNX style) and the compute layout emitted by
// the ArtCNN generator (shared-memory conv, imageStore into a SXxSY block),
// which is rewritten into a multi-render-target fragment pass.

export interface MpvPass {
    desc: string
    hook: string
    binds: string[]
    save: string | null
    width: string | null
    height: string | null
    when: string | null
    components: number
    compute: number[] | null
    body: string
}

export function parseMpvShader(src: string): MpvPass[] {
    const passes: MpvPass[] = []
    let cur: MpvPass | null = null
    let inHeader = false
    for (const line of src.replace(/\r/g, '').split('\n')) {
        const m = line.match(/^\/\/!(\w+)\s*(.*)$/)
        if (m) {
            if (!inHeader) {
                cur = { desc: '', hook: '', binds: [], save: null, width: null, height: null, when: null, components: 4, compute: null, body: '' }
                passes.push(cur)
                inHeader = true
            }
            const [, key, val] = m
            switch (key) {
            case 'DESC': cur.desc = val.trim(); break
            case 'HOOK': cur.hook = val.trim(); break
            case 'BIND': cur.binds.push(val.trim()); break
            case 'SAVE': cur.save = val.trim(); break
            case 'WIDTH': cur.width = val.trim(); break
            case 'HEIGHT': cur.height = val.trim(); break
            case 'WHEN': cur.when = val.trim(); break
            case 'COMPONENTS': cur.components = parseInt(val, 10); break
            case 'COMPUTE': cur.compute = val.trim().split(/\s+/).map(Number); break
            default: break // OFFSET, etc: not used by supported shaders
            }
            continue
        }
        inHeader = false
        if (cur) cur.body += line + '\n'
    }
    return passes.filter(p => p.hook)
}

// mpv's reverse-polish size expressions: "LUMA.w 2.0 *", "OUTPUT.w LUMA.w / 1.3 >"
export function evalRpn(expr: string, sizes: Record<string, [number, number]>): number {
    const st: number[] = []
    for (const tok of expr.trim().split(/\s+/)) {
        const v = tok.match(/^(\w+)\.(w|h|width|height)$/)
        if (v) {
            const s = sizes[v[1]]
            if (!s) throw new Error('unknown texture in expression: ' + tok)
            st.push(v[2][0] === 'w' ? s[0] : s[1])
            continue
        }
        if (/^[-+]?[\d.]+(e[-+]?\d+)?$/i.test(tok)) {
            st.push(parseFloat(tok)); continue
        }
        if (tok === '!') {
            st.push(st.pop() ? 0 : 1); continue
        }
        const b = st.pop(), a = st.pop()
        switch (tok) {
        case '+': st.push(a + b); break
        case '-': st.push(a - b); break
        case '*': st.push(a * b); break
        case '/': st.push(a / b); break
        case '>': st.push(a > b ? 1 : 0); break
        case '<': st.push(a < b ? 1 : 0); break
        case '=': st.push(a === b ? 1 : 0); break
        default: throw new Error('bad RPN token: ' + tok)
        }
    }
    return st.pop()
}

// Describes how a saved texture is laid out on the GPU.
// split > 1: mpv's (w x h) image stored as sx*sy textures of (w/sx x h/sy),
// texture k holds the texels at offset (k % sx, k / sx) of each block.
export interface TexLayout { sx: number; sy: number }

export interface CompiledPass {
    pass: MpvPass
    fs: string
    // uniform names bound to textures: [glslName, texName, splitIndex]
    samplers: [string, string, number][]
    sizeTex: string[] // textures whose *_size/_pt uniforms must be set
    outLayout: TexLayout // output layout (1x1 for fragment passes)
}

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 OUT_size;
`

function stripExt(body: string): string {
    return body.replace(/^\s*#extension.*$/gm, '')
}

function bindDecls(name: string, alias: string[], layouts: Record<string, TexLayout>, samplers: [string, string, number][]): string {
    const lay = layouts[name] || { sx: 1, sy: 1 }
    let s = ''
    if (lay.sx * lay.sy > 1) {
        for (let k = 0; k < lay.sx * lay.sy; k++) {
            s += `uniform sampler2D ${name}_raw_${k};\n`
            samplers.push([`${name}_raw_${k}`, name, k])
        }
        s += `uniform vec2 ${name}_size;\n#define ${name}_mul 1.0\n`
        return s
    }
    s += `uniform sampler2D ${name}_raw;\nuniform vec2 ${name}_size;\nuniform vec2 ${name}_pt;\n`
    samplers.push([`${name}_raw`, name, 0])
    for (const a of [name, ...alias]) {
        if (a !== name) s += `#define ${a}_raw ${name}_raw\n#define ${a}_size ${name}_size\n#define ${a}_pt ${name}_pt\n`
        s += `#define ${a}_mul 1.0
#define ${a}_off vec2(0.0)
#define ${a}_pos (gl_FragCoord.xy / OUT_size)
#define ${a}_tex(p) (${a}_mul * texture(${name}_raw, (p)))
#define ${a}_texOff(o) ${a}_tex(${a}_pos + ${name}_pt * vec2(o))
`
    }
    return s
}

export function compilePass(pass: MpvPass, layouts: Record<string, TexLayout>): CompiledPass {
    const samplers: [string, string, number][] = []
    const hooked = pass.hook
    const bound = Array.from(new Set(pass.binds.map(b => b === 'HOOKED' ? hooked : b)))
    let decl = ''
    for (const b of bound) {
        decl += bindDecls(b, b === hooked ? ['HOOKED'] : [], layouts, samplers)
    }
    if (!bound.includes(hooked)) {
        // HOOKED_* is always available in mpv, even when not explicitly bound
        decl += bindDecls(hooked, ['HOOKED'], layouts, samplers)
    }
    const sizeTex = Array.from(new Set(samplers.map(s => s[1])))
    let body = stripExt(pass.body)

    if (!pass.compute) {
        const fs = HEADER + decl + 'layout(location = 0) out vec4 out_0;\n' + body + '\nvoid main() { out_0 = hook(); }\n'
        return { pass, fs, samplers, sizeTex, outLayout: { sx: 1, sy: 1 } }
    }

    // ---- compute -> fragment rewrite ----
    const [, , tw, th] = pass.compute
    body = body.replace(/gl_WorkGroupSize/g, `uvec3(${tw}u, ${th}u, 1u)`)
    body = body.replace(/^\s*shared .*;\s*$/gm, '')

    const ob = body.match(/output_base\s*=\s*ivec2\(gl_GlobalInvocationID\)\s*\*\s*ivec2\((\d+),\s*(\d+)\)/)
    const osx = ob ? parseInt(ob[1], 10) : 1
    const osy = ob ? parseInt(ob[2], 10) : 1

    // shared-memory load loop -> per-channel loader functions
    const loopStart = body.search(/\n\s*for \(uint y = local_xy\.y/)
    const barrier = body.indexOf('barrier();')
    let loaders = ''
    if (loopStart >= 0 && barrier > loopStart) {
        const loop = body.slice(loopStart, barrier)
        const ib = loop.match(/input_base\s*=\s*\(base \+ ivec2\(x,\s*y\) - offset\)\s*\*\s*ivec2\((\d+),\s*(\d+)\)/)
        const isx = parseInt(ib[1], 10), isy = parseInt(ib[2], 10)
        const assigns = Array.from(loop.matchAll(/inp\[(\d+)\]\[y\]\[x\]\s*=\s*(.+);/g))
        const typeM = pass.body.match(/shared\s+(\w+)\s+inp/)
        const T = typeM ? typeM[1] : 'V4'
        for (const [, k, exprRaw] of assigns) {
            // texelFetch(NAME_raw, input_base + ivec2(a, b), 0)
            const expr = exprRaw.replace(/texelFetch\((\w+?)_raw,\s*input_base \+ ivec2\((\d+),\s*(\d+)\),\s*0\)/g, (_m, name, a, b) => {
                const lay = layouts[name] || { sx: 1, sy: 1 }
                if (lay.sx * lay.sy > 1) {
                    if (lay.sx !== isx || lay.sy !== isy) throw new Error(`layout mismatch reading ${name}`)
                    return `texelFetch(${name}_raw_${parseInt(b, 10) * lay.sx + parseInt(a, 10)}, p, 0)`
                }
                return `texelFetch(${name}_raw, p * ivec2(${isx}, ${isy}) + ivec2(${a}, ${b}), 0)`
            })
            loaders += `${T} inp_load_${k}(ivec2 p) {
    if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, ivec2(OUT_size)))) return ${T}(0.0);
    return ${expr};
}
`
        }
        body = body.slice(0, loopStart) + '\n' + body.slice(barrier + 'barrier();'.length)
    }
    body = body.replace(/inp\[(\d+)\]\[local_xy\.y \+ (\d+)\]\[local_xy\.x \+ (\d+)\]/g,
        (_m, k, dy, dx) => `inp_load_${k}(gid + ivec2(${dx}, ${dy}) - offset)`)
    body = body.replace(/^\s*const uvec2 local_xy = .*$/gm, '')
    body = body.replace(/^\s*ivec2 base = ivec2\(gl_WorkGroupID\).*$/gm, '')
    body = body.replace(/^\s*const ivec2 output_base = .*$/gm, '')
    // imageStore -> MRT outputs
    body = body.replace(/imageStore\(out_image,\s*output_base \+ ivec2\((\d+),\s*(\d+)\),\s*(.+)\);/g,
        (_m, a, b, v) => `out_${parseInt(b, 10) * osx + parseInt(a, 10)} = vec4(${v});`)
    body = body.replace(/imageStore\(out_image,\s*ivec2\(gl_GlobalInvocationID\),\s*(.+)\);/g, (_m, v) => `out_0 = vec4(${v});`)
    // GLSL ES forbids const locals with non-constant initialisers; drop const inside hook()
    const hk = body.indexOf('void hook()')
    body = body.slice(0, hk) + body.slice(hk).replace(/(^|\n)(\s*)const /g, '$1$2')
    body = body.replace('void hook() {', loaders + 'void hook() {\n    ivec2 gid = ivec2(gl_FragCoord.xy);')

    const nOut = osx * osy
    let outs = ''
    for (let k = 0; k < nOut; k++) outs += `layout(location = ${k}) out vec4 out_${k};\n`
    const fs = HEADER + decl + outs + body + '\nvoid main() { hook(); }\n'
    return { pass, fs, samplers, sizeTex, outLayout: { sx: osx, sy: osy } }
}
