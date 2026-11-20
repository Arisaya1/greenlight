// Injects a 1 Hz WebRTC/long-task probe into the renderer. Lines land in combined.log as [r:log] [glstats] ...
// usage: node dbg/probe.mjs            (install probe + print a cumulative snapshot)
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:8888'))
if (!page) { console.log('no renderer page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const call = (method, params) => new Promise((resolve) => {
  const myId = ++id
  const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === myId) { ws.removeEventListener('message', onMsg); resolve(m.result) } }
  ws.addEventListener('message', onMsg)
  ws.send(JSON.stringify({ id: myId, method, params }))
})

const inject = `(() => {
  const V = 2
  if (window.__glProbe && !window.__glProbe.neutered) Object.defineProperty(window, '__glProbe', { configurable: true, writable: true, value: { neutered: true, get pc() { return null }, set pc(x) {}, prev: null } })
  if (window.__glProbe2 && window.__glProbe2.v !== V) {
    for (const t of window.__glProbe2.timers || []) clearInterval(t)
    if (!window.__glProbe2.timers) Object.defineProperty(window, '__glProbe', { configurable: true, writable: true, value: { get pc() { return null }, set pc(x) {} } })
    window.__glProbe2.dead = true
  }
  if (!window.__glProbe2 || window.__glProbe2.dead) {
    const P = window.__glProbe2 = { v: V, pc: null, prev: null, timers: [], lt: [], pres: { n: 0, frames: null, last: 0, maxGap: 0, gaps: 0 }, raf: { n: 0, last: 0, maxGap: 0 } }
    const orig = RTCPeerConnection.prototype.getStats
    RTCPeerConnection.prototype.getStats = function (...a) { if (this.connectionState !== 'closed' && window.__glProbe2 === P) P.pc = this; return orig.apply(this, a) }
    try { new PerformanceObserver((l) => { if (window.__glProbe2 === P) for (const e of l.getEntries()) if (e.duration >= 50) P.lt.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] }) } catch (e) {}
    let vid = null
    const vfc = (now, m) => {
      if (window.__glProbe2 !== P) return
      const q = P.pres; q.n++
      if (q.last) { const g = m.presentationTime - q.last; if (g > q.maxGap) q.maxGap = g; if (g > 25) q.gaps++ }
      q.last = m.presentationTime
      if (q.frames === null) q.frames0 = m.presentedFrames
      q.frames = m.presentedFrames
      vid.requestVideoFrameCallback(vfc)
    }
    const hook = () => { const v = document.querySelector('video[id$=_videoRender]'); if (v && v !== vid) { vid = v; vid.requestVideoFrameCallback(vfc) } }
    const raf = (t) => { if (window.__glProbe2 !== P) return; const r = P.raf; if (r.last) { const g = t - r.last; if (g > r.maxGap) r.maxGap = g } r.last = t; r.n++; requestAnimationFrame(raf) }
    requestAnimationFrame(raf)
    P.timers.push(setInterval(async () => {
      hook()
      const q = P.pres, r = P.raf
      const presLine = ' | shown=' + q.n + ' skip=' + Math.max(0, (q.frames ?? 0) - (q.frames0 ?? 0) - q.n) + ' maxGap=' + Math.round(q.maxGap) + 'ms gaps>25ms=' + q.gaps + ' | raf=' + r.n + ' rafMax=' + Math.round(r.maxGap) + 'ms' + (P.lt.length ? ' longtasks=' + P.lt.join(',') : '')
      q.n = 0; q.maxGap = 0; q.gaps = 0; q.frames0 = q.frames; r.n = 0; r.maxGap = 0; P.lt = []
      const pc = P.pc; if (!pc) return
      const s = await pc.getStats(); let v = null, cp = null
      s.forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'video') v = x; if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') cp = x })
      if (!v) return
      const p = P.prev || v; P.prev = v
      const d = (k) => (v[k] ?? 0) - (p[k] ?? 0)
      const jbd = d('jitterBufferEmittedCount') ? Math.round(1000 * d('jitterBufferDelay') / d('jitterBufferEmittedCount')) : 0
      const dec = d('framesDecoded') ? Math.round(10000 * d('totalDecodeTime') / d('framesDecoded')) / 10 : 0
      console.log('[glstats] recv=' + d('framesReceived') + ' dec=' + d('framesDecoded') + ' drop=' + d('framesDropped') +
        ' lost=' + d('packetsLost') + ' nack=' + d('nackCount') + ' pli=' + d('pliCount') + ' key=' + d('keyFramesDecoded') +
        ' freeze=' + d('freezeCount') + '/' + Math.round(1000 * d('totalFreezesDuration')) + 'ms jb=' + jbd + 'ms decT=' + dec + 'ms' +
        ' kbps=' + Math.round(d('bytesReceived') * 8 / 1000) + ' rtt=' + (cp ? Math.round(cp.currentRoundTripTime * 1000) : '?') + 'ms' + presLine)
    }, 1000))
  }
  const pc = window.__glProbe2.pc; if (!pc) return 'probe installed; pc not captured yet'
  return pc.getStats().then((s) => { let o = {}; s.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') o = r }); return JSON.stringify({ freezeCount: o.freezeCount, totalFreezesDuration: o.totalFreezesDuration, pliCount: o.pliCount, nackCount: o.nackCount, packetsLost: o.packetsLost, framesDropped: o.framesDropped }) })
})()`
await call('Runtime.evaluate', { expression: inject, awaitPromise: true, returnByValue: true })
await new Promise((r) => setTimeout(r, 1500))
const res = await call('Runtime.evaluate', { expression: inject, awaitPromise: true, returnByValue: true })
console.log(res?.result?.value ?? JSON.stringify(res))
ws.close()
