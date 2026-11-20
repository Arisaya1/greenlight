# Video freezing for ~3s while audio keeps playing

Branch: `fix/stream-freeze-keyframe` (commit f243c4e)

## Symptom

During an xHome stream (Series S, GTA Online, 1080p60) the picture would stick on one frame for a couple of seconds. Game audio kept going, and then the video jumped back in. In one session of about 4 minutes there were 4 of these, adding up to 12.3s of frozen video.

## What the stats showed

Greenlight's logs don't include video stats, so `dbg/probe.mjs` injects a once-per-second `getStats()` sampler into the renderer. One freeze happened while it was running:

```
00:17:37.965 recv=0  dec=0  lost=0 nack=0 kbps=15326
00:17:38.961 recv=0  dec=0  lost=0 nack=0 kbps=15202
00:17:39.964 recv=16 dec=16 pli=1 key=1 freeze=1/3093ms
```

Video data kept arriving at full bitrate the whole time, with zero packets lost and no NACKs sent. Even so, no frames reached the decoder. After about 3 seconds the browser sent a PLI (picture loss indication), the console answered with a keyframe and video came back.

## Cause

H.264 delta frames depend on the frames before them. Once one frame fails to come together, every frame after it gets held back until the next keyframe. The network never reported a loss, so nothing asked for a keyframe early. libwebrtc only asks for one on its own after 3 seconds with no decodable frame, so every freeze lasted about 3 seconds.

The broken frame itself comes from the console or the network path. We can't fix that from the client side, but we can make the recovery much faster.

## Fix

`packages/desktop/renderer/lib/stallwatchdog.ts`, started from `streamcomponent.tsx`:

- Polls the inbound video stats every 100ms.
- If `framesDecoded` hasn't moved for 250ms while `bytesReceived` is still going up, it sends `videoKeyframeRequested` over the xCloud control channel (`getChannelProcessor('control').requestKeyframeRequest()`, which xbox-xcloud-player already had and nobody called).
- After a request it waits at least 1s before sending another. It does nothing while the window is hidden or before the first frame has decoded.

When I triggered the request by hand mid-stream, a keyframe came back within the next one-second sample. A stall should now cost about half a second instead of three.

Each time the watchdog fires, it logs a `StallWatchdog:` warning to the renderer console.

## Not fixed: small frame-pacing hitches

The other complaint, an uneven frame rate, is a different problem. Frames arrive and decode at a steady ~60fps, but the console negotiates the playout-delay RTP extension. That puts Chromium in low-latency rendering mode, where frames are shown the moment they arrive. If the network delivers a few frames in a burst, the extras get dropped at display time (0 to 13 per second in the samples). Setting `receiver.jitterBufferTarget = 33` changed nothing, because the low-latency path ignores it. To smooth this out you'd have to remove playout-delay from the SDP offer, and that adds input latency. Left as is for now.
