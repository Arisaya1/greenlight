// Video can stop decoding while packets keep arriving (a frame that never
// assembles blocks every delta frame after it). libwebrtc only sends its own
// keyframe request after 3s without a decodable frame, so the picture freezes
// for ~3s. Ask the console for a keyframe as soon as decoding stalls instead.
export default function startStallWatchdog(xPlayer, stallMs = 250, cooldownMs = 1000) {
    let lastDecoded = 0
    let lastBytes = 0
    let lastProgress = performance.now()
    let lastRequest = 0
    let busy = false

    const timer = setInterval(async () => {
        const pc = xPlayer._webrtcClient
        if (busy || pc === undefined || pc.connectionState !== 'connected' || document.visibilityState !== 'visible') {
            return
        }

        busy = true
        try {
            const stats = await pc.getStats()
            stats.forEach((report) => {
                if (report.type !== 'inbound-rtp' || report.kind !== 'video') {
                    return
                }

                const now = performance.now()
                const decoded = report.framesDecoded || 0
                const receiving = report.bytesReceived > lastBytes
                lastBytes = report.bytesReceived

                if (decoded !== lastDecoded || decoded === 0) {
                    lastDecoded = decoded
                    lastProgress = now
                    return
                }

                if (receiving && now - lastProgress >= stallMs && now - lastRequest >= cooldownMs) {
                    lastRequest = now
                    console.warn('StallWatchdog: no video frames decoded for', Math.round(now - lastProgress), 'ms while packets arrive. Requesting keyframe')
                    xPlayer.getChannelProcessor('control').requestKeyframeRequest()
                }
            })
        } finally {
            busy = false
        }
    }, 100)

    return () => clearInterval(timer)
}
