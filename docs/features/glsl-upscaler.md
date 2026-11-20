# mpv upscaling shaders (FSRCNNX, ArtCNN) in the stream view

Branch: `feat/glsl-upscaler` (commit d259685)

## What it does

While streaming you can run the stream's video through FSRCNNX or ArtCNN, the same .glsl shaders mpv loads with `glsl-shaders=`. The gamebar has a new **Upscale** button that opens a small panel:

- Shader: Off, FSRCNNX x2 8-0-4-1, ArtCNN C4F16, ArtCNN C4F32
- Apply: "Only when upscaling" (the shader's own `//!WHEN` rule, same as mpv) or "Always"
- Scale to screen: Catmull-Rom (sharp) or bilinear (soft)
- Shader strength, 0-200%: how much of the shader's added detail to apply. 100% is the shader as-is, 200% doubles the detail it adds over a plain upscale, 0% is a plain Catmull-Rom/bilinear upscale. Double-click resets it to 100%.
- Stats overlay: input/output resolution, fps and GPU ms per frame

The settings are saved in localStorage (`greenlight.upscaler`).

## Why it needed a translator

Greenlight plays the stream in a Chromium `<video>` element. A browser can't load mpv shaders as-is: they are written for mpv/libplacebo's hook system, and ArtCNN uses compute shaders (`//!COMPUTE`, shared memory, `imageStore`). WebGL2 has no compute shaders at all.

So I wrote a small runtime that reads the .glsl files unchanged and turns them into WebGL2 fragment shaders when they load. The shader files sit in `renderer/public/shaders/` exactly as downloaded.

## How it works

`lib/upscaler/mpvshader.ts` handles the parsing and translation:

- Parses the `//!HOOK / BIND / SAVE / WIDTH / HEIGHT / WHEN / COMPUTE` headers and evaluates mpv's reverse-polish size expressions (`LUMA.w 2.0 *`).
- Fragment passes (all of FSRCNNX) get the usual mpv macros defined: `NAME_tex`, `NAME_texOff`, `NAME_pos`, `NAME_pt`, `NAME_size`, plus `HOOKED_*`.
- Compute passes (ArtCNN) get rewritten. Each compute thread writes a 2x2 (C4F16) or 4x2 (C4F32) block of texels with `imageStore`. I turned each thread into one fragment that writes 4 or 8 render targets at once (MRT), so there's no wasted work. The shared-memory tile load becomes small loader functions that `texelFetch` straight from the previous pass's targets, returning zero outside the image (same padding the network expects). `const` locals get stripped, because GLSL ES rejects non-constant initializers.

`lib/upscaler/upscaler.ts` runs it every frame:

1. A `<canvas>` sits over the video with `pointer-events: none`, so mouse input still reaches the video underneath.
2. Each new video frame (`requestVideoFrameCallback`) is uploaded to a texture, and a pass turns it into a BT.709 luma plane.
3. The shader passes run on that luma into RGBA16F targets, sized per their WIDTH/HEIGHT rules.
4. A compose pass resamples the upscaled luma to the screen size and adds it back onto the bilinear colour: `rgb + (Y_upscaled - Y_original)`. That keeps the chroma and swaps in the sharp luma, which is roughly what mpv does with a LUMA hook. The strength slider scales the shader's contribution here: `Y = Y_plain + strength * (Y_shader - Y_plain)`, where `Y_plain` is the pre-shader luma resampled the same way. At 100% this step is skipped. At 0%, 100% and 200% I measured the added detail at 0x, 1x and 1.97x, and 100% still matches libplacebo at 49.3 dB. Letterboxing follows the video's `object-fit`, so the stretch and zoom settings still work.
5. Shaders compile through `KHR_parallel_shader_compile`, so loading one doesn't block the stream for long.

The UI lives in `components/ui/upscalermenu.tsx` and is wired into `streamcomponent.tsx`. It finds the stream's video element on its own and reattaches if xbox-xcloud-player replaces it.

## How I checked it

I downscaled a test image to 1280x684 and ran it through ffmpeg's libplacebo filter, which is the renderer mpv itself uses, with each shader. Then I ran the same image through the WebGL path in Chrome on the GTX 1070 and compared the luma:

| Shader | WebGL vs libplacebo | libplacebo vs plain bilinear |
|---|---|---|
| FSRCNNX x2 8-0-4-1 | 49.6 dB | 26.4 dB |
| ArtCNN C4F16 | 49.3 dB | 26.2 dB |
| ArtCNN C4F32 | 50.1 dB | |

At around 50 dB the outputs are visually the same. The small leftover gap comes from half-float targets and mpv's limited-range luma. A bad translation would land near the bilinear number, not 50. Side-by-side crops looked identical too.

After that I loaded it in the running dev app during a live 1080p stream. Every shader compiled (the log shows `[upscaler] loaded ...`), and there were no renderer errors.

## Cost on a GTX 1070

GPU time per frame, measured with the WebGL pipeline at "Always":

| Shader | 720p stream | 1080p stream into 1080p window |
|---|---|---|
| FSRCNNX | ~12 ms | ~24 ms |
| ArtCNN C4F16 | ~16 ms | ~38 ms |
| ArtCNN C4F32 | ~57 ms | too slow |

You need under ~16.7 ms per frame for 60 fps. CNN cost follows the input resolution, not the output. In practice: with a 720p stream FSRCNNX and C4F16 keep up, while with a 1080p stream nothing reaches 60 on this card. A 1080p stream in a 1080p window also never meets the `WHEN` rule (it needs 1.3x upscaling), so "Only when upscaling" leaves it idle on purpose.

## Limits

- Only LUMA hooks are supported, which covers these three files (others are untested). Shaders that hook MAIN/RGB/CHROMA or use embedded `//!TEXTURE` data won't load yet. The panel shows the error instead.
- The canvas redraws when the browser reports a new video frame, so it can trail the raw video by about a frame while on. With it off, nothing changes from stock Greenlight.
- The first load of C4F32 can take a second or so to compile. Later loads come out of the GPU's shader cache.
