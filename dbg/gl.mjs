#!/usr/bin/env node
// Greenlight debug harness.  Usage: node dbg/gl.mjs <start|stop|restart|reload|status|tail|since|errors|grep|mark> [args]
// Runs the dev build under a detached supervisor that timestamps + redacts everything into dbg/logs/.
import fs from 'node:fs'
import path from 'node:path'
import cp from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const DBG = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DBG, '..')
const DESKTOP = path.join(ROOT, 'packages', 'desktop')
const LOGS = path.join(DBG, 'logs')
const ARCHIVE = path.join(LOGS, 'archive')
const F = {
    combined: path.join(LOGS, 'combined.log'),
    main: path.join(LOGS, 'main.log'),
    renderer: path.join(LOGS, 'renderer.log'),
    state: path.join(DBG, 'state.json'),
}
const PORT = process.env.GL_DEBUG_PORT || '9222'      // renderer CDP (--remote-debugging-port)
const INSPECT = process.env.GL_INSPECT_PORT || '9292' // main-process node inspector (--inspect-brk)
// main-process debug namespaces (greenlight itself + libs that use `debug`)
const DEBUG_NS = process.env.GL_DEBUG_NS || 'greenlight:*,xbox-xcloud-player*,xal-node*,xbox-webapi*,xcloud*'

const RENDERER_PORT = '8888' // nextron's default next-dev port
const RELOAD_FLAG = path.join(DBG, 'reload.flag')

const pad = (n, w = 2) => String(n).padStart(w, '0')
const ts = (d = new Date()) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`

// Keep tokens/blobs out of the logs (and out of the agent's context window).
function redact(s) {
    return s
        .replace(/((?:access_|refresh_|id_)?token|gsToken|Token|password|secret|authorization|cookie)(['"]?\s*[:=]\s*['"]?)(?:Bearer\s+)?[^\s'",}]{12,}/gi, '$1$2<redacted>')
        .replace(/eyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]{5,}){0,2}/g, '<jwt>')
        .replace(/[^\s'"`,(){}<>]{100,}/g, (m) => `<blob:${m.length}>`)
}

function readState() {
    try { return JSON.parse(fs.readFileSync(F.state, 'utf8')) } catch { return null }
}
function alive(pid) {
    if (!pid) return false
    try { process.kill(pid, 0); return true } catch { return false }
}
function killTree(pid) {
    if (!pid) return
    try { cp.execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
}

// Processes belonging to THIS checkout only (never touches the installed Greenlight.exe or other node apps).
function psPids(name, cond) {
    try {
        const out = cp.execFileSync('powershell', ['-NoProfile', '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { ${cond} } | Select-Object -ExpandProperty ProcessId`],
            { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
        return out.split(/\s+/).map(Number).filter(Boolean)
    } catch { return [] }
}
const rootLc = ROOT.toLowerCase()
function sweepElectron() {
    for (const pid of psPids('electron.exe', `$_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith('${rootLc}') -and $_.CommandLine -notmatch '--type='`)) killTree(pid)
}
function sweepNode() { // next dev / webpack workers spawned out of this checkout's node_modules (not the supervisor: that runs dbg/gl.mjs)
    for (const pid of psPids('node.exe', `$_.CommandLine -and $_.CommandLine.ToLower().Contains('${rootLc}\\node_modules')`)) killTree(pid)
}
function sweepAll() { sweepElectron(); sweepNode() }

// ───────────────────────── supervisor (detached) ─────────────────────────
async function supervise() {
    fs.mkdirSync(ARCHIVE, { recursive: true })
    // rotate previous run
    const stamp = ts().replace(/[: ]/g, '-').replace('.', '_')
    const old = Object.values(F).slice(0, 3).filter((f) => fs.existsSync(f) && fs.statSync(f).size > 0)
    if (old.length) {
        const dir = path.join(ARCHIVE, stamp)
        fs.mkdirSync(dir, { recursive: true })
        for (const f of old) fs.renameSync(f, path.join(dir, path.basename(f)))
    }
    const out = {
        combined: fs.createWriteStream(F.combined, { flags: 'a' }),
        main: fs.createWriteStream(F.main, { flags: 'a' }),
        renderer: fs.createWriteStream(F.renderer, { flags: 'a' }),
    }
    const emit = (tag, text, file) => {
        for (const line of String(text).split(/\r?\n/)) {
            if (!line.trim()) continue
            const l = `${ts()} [${tag}] ${redact(line)}\n`
            out.combined.write(l)
            if (file) out[file].write(l)
        }
    }

    const require = createRequire(path.join(DESKTOP, 'package.json'))
    const nextron = require.resolve('nextron/bin/nextron.cjs')
    const env = {
        ...process.env,
        DEBUG: DEBUG_NS,
        DEBUG_COLORS: 'no',
        DEBUG_HIDE_DATE: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        NEXT_TELEMETRY_DISABLED: '1',
    }
    delete env.ELECTRON_RUN_AS_NODE // Hermes itself is Electron; this would make the dev app boot as plain node
    delete env.PYTHONPATH

    // nextron runs electron detached (stdout/stderr never reach us), so main-process output is pulled over the node inspector instead.
    // --inspect-brk holds the app at line 1 until we attach, so no startup logs are missed.
    const electronOpts = `--remote-debugging-port=${PORT} --inspect-brk=${INSPECT}`
    let child = null, stopping = false
    const relaunches = []
    const pipeLines = (stream, tag) => {
        let buf = ''
        stream.on('data', (d) => {
            buf += d.toString()
            const parts = buf.split(/\r?\n/)
            buf = parts.pop()
            for (const p of parts) emit(tag, p, 'main')
        })
        stream.on('end', () => buf && emit(tag, buf, 'main'))
    }
    function launch(why) {
        const c = cp.spawn(process.execPath, [nextron, 'dev', '--electron-options', electronOpts], { cwd: DESKTOP, env, stdio: ['ignore', 'pipe', 'pipe'] })
        child = c
        fs.writeFileSync(F.state, JSON.stringify({ supervisorPid: process.pid, childPid: c.pid, started: readState()?.started || ts(), port: PORT }, null, 2))
        emit('sup', `${why} nextron pid=${c.pid} DEBUG=${DEBUG_NS} renderer-cdp=${PORT} main-inspector=${INSPECT}`)
        pipeLines(c.stdout, 'main:out')
        pipeLines(c.stderr, 'main:err')
        c.on('exit', (code, sig) => {
            if (c !== child) return
            emit('sup', `nextron exited code=${code} signal=${sig}`)
            killTree(c.pid); sweepAll() // sweep orphaned next-dev / electron
            // nextron crashes (code 1) every time it hot-restarts electron after a main-process rebuild on Windows. Treat as "reload".
            const recent = relaunches.filter((t) => Date.now() - t < 60000)
            if (!stopping && code === 1 && recent.length < 5) {
                relaunches.push(Date.now())
                emit('sup', 'main-process rebuilt (nextron hot-restart crashes on Windows): relaunching')
                setTimeout(() => launch('relaunched'), 1000)
            } else {
                setTimeout(() => process.exit(0), 500)
            }
        })
    }
    fs.writeFileSync(F.state, JSON.stringify({ supervisorPid: process.pid, started: ts(), port: PORT }))
    launch('started')

    // ── renderer capture over CDP ──
    const attached = new Set()
    const R = (tag, text) => emit(tag, text, 'renderer')
    async function attach(t) {
        attached.add(t.id)
        const isMain = t.type === 'node'
        const P = isMain ? 'm' : 'r'
        const ws = new WebSocket(t.webSocketDebuggerUrl)
        let id = 0
        const pending = new Map()
        const reqUrl = new Map()
        const send = (method, params = {}) => new Promise((res) => {
            const i = ++id
            pending.set(i, res)
            ws.send(JSON.stringify({ id: i, method, params }))
        })
        let queue = Promise.resolve()
        const fmtArg = async (a) => {
            if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value)
            if (a.unserializableValue) return a.unserializableValue
            if (a.type === 'object' && a.objectId && a.subtype !== 'node') {
                const r = await send('Runtime.callFunctionOn', {
                    objectId: a.objectId,
                    functionDeclaration: 'function(){try{const seen=new WeakSet();return JSON.stringify(this,(k,v)=>{if(typeof v==="object"&&v){if(seen.has(v))return "[circular]";seen.add(v)}return v},1).slice(0,4000)}catch(e){return String(this)}}',
                    returnByValue: true,
                })
                return r?.result?.result?.value ?? a.description ?? a.type
            }
            return a.description ?? a.type
        }
        ws.addEventListener('open', async () => {
            R(`${P}:sup`, `attached ${t.url || t.title}`)
            if (isMain) {
                await send('Runtime.enable')
                // debug() writes to process.stderr, which isn't a console call; mirror it into the console so we can see it.
                await send('Runtime.evaluate', { expression: `(()=>{if(process.__glHook)return;process.__glHook=true;const w=process.stderr.write.bind(process.stderr);process.stderr.write=function(c,...a){try{console.log('\\u0001'+String(c).replace(/\\r?\\n$/,''))}catch(e){}return w(c,...a)}})()` })
                await send('Runtime.runIfWaitingForDebugger')
            } else {
                for (const m of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await send(m)
            }
        })
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data)
            if (msg.id) { pending.get(msg.id)?.(msg); pending.delete(msg.id); return }
            const p = msg.params || {}
            queue = queue.then(async () => {
                switch (msg.method) {
                    case 'Runtime.consoleAPICalled': {
                        const parts = []
                        for (const a of p.args || []) parts.push(await fmtArg(a))
                        const loc = p.stackTrace?.callFrames?.[0]
                        const text = parts.join(' ')
                        if (isMain) {
                            // stderr hook lines (debug(), console.error/warn) carry a \u0001 marker; skip the raw error/warn API events to avoid dupes
                            if (text.startsWith('\u0001')) R('m:stderr', text.slice(1))
                            else if (!['error', 'warning', 'assert'].includes(p.type)) R(`m:${p.type}`, text)
                        } else {
                            R(`r:${p.type}`, text + (loc && p.type === 'error' ? `  (${loc.url}:${loc.lineNumber})` : ''))
                        }
                        break
                    }
                    case 'Runtime.exceptionThrown': {
                        const d = p.exceptionDetails || {}
                        R(`${P}:exception`, `${d.exception?.description || d.text} (${d.url || ''}:${d.lineNumber})`)
                        break
                    }
                    case 'Log.entryAdded':
                        R(`r:log:${p.entry.level}`, `${p.entry.source}: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`)
                        break
                    case 'Network.requestWillBeSent': reqUrl.set(p.requestId, p.request.url); break
                    case 'Network.responseReceived':
                        if (p.response.status >= 400) R('r:net', `HTTP ${p.response.status} ${p.response.url}`)
                        break
                    case 'Network.loadingFailed':
                        if (!p.canceled) R('r:net', `FAILED ${p.errorText} ${reqUrl.get(p.requestId) || ''}`)
                        break
                    case 'Network.webSocketCreated': R('r:ws', `open ${p.url}`); break
                    case 'Network.webSocketClosed': R('r:ws', `closed ${reqUrl.get(p.requestId) || p.requestId}`); break
                    case 'Network.webSocketFrameError': R('r:ws', `error ${p.errorMessage}`); break
                    case 'Page.frameNavigated':
                        if (!p.frame.parentId) R('r:nav', p.frame.url)
                        break
                    case 'Inspector.targetCrashed': R('r:crash', 'renderer crashed'); break
                }
            }).catch(() => {})
        })
        ws.addEventListener('close', () => { R(`${P}:sup`, `detached ${t.url || t.title}`); attached.delete(t.id) })
        ws.addEventListener('error', () => {})
    }
    const poll = async (port, wantType) => {
        try {
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
            for (const t of list) {
                if (t.type !== wantType || attached.has(t.id) || !t.webSocketDebuggerUrl) continue
                if (/^(devtools|chrome|chrome-extension):/.test(t.url || '')) continue
                attach(t)
            }
        } catch { /* app not up yet */ }
    }
    setInterval(() => { poll(INSPECT, 'node'); poll(PORT, 'page') }, 500)

    // `gl.mjs reload` drops a flag file: full relaunch (also used to bring the app back after you closed its window)
    setInterval(() => {
        if (!fs.existsSync(RELOAD_FLAG)) return
        fs.rmSync(RELOAD_FLAG, { force: true })
        emit('sup', 'reload requested')
        const old = child
        child = null
        killTree(old?.pid); sweepAll()
        setTimeout(() => launch('reloaded'), 1500)
    }, 500)

    const shutdown = () => { stopping = true; killTree(child?.pid); sweepAll(); setTimeout(() => process.exit(0), 300) }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
}

// ───────────────────────── controller ─────────────────────────
function running() {
    const s = readState()
    return s && alive(s.supervisorPid) ? s : null
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readLines() {
    try { return fs.readFileSync(F.combined, 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
function parseDur(s = '60s') {
    const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(s)
    if (!m) throw new Error(`bad duration: ${s} (try 30s, 5m, 1h)`)
    return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, undefined: 1000 }[m[2]]
}
function linesSince(dur) {
    const cutoff = ts(new Date(Date.now() - parseDur(dur))) // same lexicographic format
    return readLines().filter((l) => l.slice(0, 23) >= cutoff)
}

async function start() {
    if (running()) { console.log('already running'); return status() }
    if (!fs.existsSync(path.join(ROOT, 'node_modules'))) { console.error('node_modules missing: run `yarn install` in repo root first'); process.exit(1) }
    fs.mkdirSync(LOGS, { recursive: true })
    sweepAll() // clear orphans from any crashed previous run (frees :8888/:9222/:9292)
    const sup = cp.spawn(process.execPath, [fileURLToPath(import.meta.url), '__supervise'], {
        detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT,
    })
    sup.unref()
    console.log(`supervisor pid=${sup.pid}; waiting for app to boot (max 120s)...`)
    for (let i = 0; i < 120; i++) {
        await sleep(1000)
        const txt = readLines().join('\n')
        if (/fully loaded|Electron has been fully/.test(txt)) { console.log('app is up'); break }
        if (/nextron exited/.test(txt)) { console.log('app exited during boot'); break }
        if (i === 119) console.log('timeout waiting for boot; check `tail`')
    }
    console.log(readLines().slice(-15).join('\n'))
}
function stop() {
    const s = readState()
    if (!s) { sweepAll(); return console.log('not running (swept orphans)') }
    killTree(s.supervisorPid)
    killTree(s.childPid)
    sweepAll()
    console.log('stopped')
}
function status() {
    const s = running()
    if (!s) return console.log('NOT running')
    const lines = readLines()
    console.log(`running since ${s.started} | supervisor=${s.supervisorPid} nextron=${s.childPid} | renderer-cdp=127.0.0.1:${PORT} main-inspector=127.0.0.1:${INSPECT} | ${lines.length} log lines`)
    console.log(`last: ${lines.at(-1) || '(none)'}`)
    console.log(`logs: ${LOGS}`)
}

const [cmd, ...args] = process.argv.slice(2)
switch (cmd) {
    case '__supervise': await supervise(); break
    case 'start': await start(); break
    case 'stop': stop(); break
    case 'restart': stop(); await sleep(1500); await start(); break
    case 'status': status(); break
    case 'reload': fs.writeFileSync(RELOAD_FLAG, '1'); console.log('reload requested (full relaunch, ~15s)'); break
    case 'tail': console.log(readLines().slice(-(Number(args[0]) || 80)).join('\n')); break
    case 'since': console.log(linesSince(args[0] || '60s').join('\n')); break
    case 'errors': {
        const re = /error|warn|exception|fail|ERR_|refused|timed? ?out|unhandled|denied|crash|\[r:ws\]|HTTP [45]\d\d|\[MARK\]/i
        console.log(linesSince(args[0] || '10m').filter((l) => re.test(l)).join('\n'))
        break
    }
    case 'grep': {
        const re = new RegExp(args[0], 'i')
        console.log(readLines().filter((l) => re.test(l)).slice(-(Number(args[1]) || 100)).join('\n'))
        break
    }
    case 'mark': {
        fs.appendFileSync(F.combined, `${ts()} [MARK] ${args.join(' ') || 'mark'}\n`)
        console.log('marked')
        break
    }
    default:
        console.log('usage: node dbg/gl.mjs <start|stop|restart|status|tail [n]|since <30s|5m>|errors [dur]|grep <re> [n]|mark <text>>')
}
