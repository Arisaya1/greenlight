import React from 'react'
import { Upscaler, UpscalerSettings, UpscalerStatus, SHADERS, loadSettings, saveSettings } from '../../lib/upscaler/upscaler'

// Attaches the shader upscaler to the stream <video> and renders its settings panel.
export default function UpscalerMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [settings, setSettings] = React.useState<UpscalerSettings>(loadSettings)
    const [status, setStatus] = React.useState<UpscalerStatus | null>(null)
    const upscaler = React.useRef<Upscaler | null>(null)
    const settingsRef = React.useRef(settings)
    settingsRef.current = settings

    React.useEffect(() => {
        let video: HTMLVideoElement | null = null
        const attach = () => {
            const v = document.querySelector('#streamComponent video') as HTMLVideoElement | null
            if (v === video) return
            upscaler.current?.destroy()
            upscaler.current = null
            video = v
            if (!v) return
            try {
                const u = new Upscaler(v, settingsRef.current)
                u.onStatus = setStatus
                upscaler.current = u
            } catch (e) {
                console.error('[upscaler] init failed', e)
                setStatus({ active: false, loading: false, error: String(e && e.message || e), inSize: [0, 0], outSize: [0, 0], fps: 0, gpuMs: null })
            }
        }
        attach()
        const iv = setInterval(attach, 1000)
        return () => {
            clearInterval(iv)
            upscaler.current?.destroy()
            upscaler.current = null
        }
    }, [])

    const update = (patch: Partial<UpscalerSettings>) => {
        const next = { ...settings, ...patch }
        setSettings(next)
        saveSettings(next)
        upscaler.current?.apply(next)
    }

    const statusText = (() => {
        if (settings.shader === 'off') return 'Off'
        if (!status) return 'Waiting for video'
        if (status.error) return 'Error: ' + status.error
        if (status.loading) return 'Compiling shader…'
        const io = `${status.inSize[0]}×${status.inSize[1]} → ${status.outSize[0]}×${status.outSize[1]}`
        if (!status.active) return `Idle (${io}): not upscaling enough to kick in. Set Apply to Always to force it.`
        return `Active · ${io} · ${status.fps} fps` + (status.gpuMs !== null ? ` · ${status.gpuMs.toFixed(1)} ms GPU` : '')
    })()

    return (
        <React.Fragment>
            {settings.stats && settings.shader !== 'off' && (
                <div id="component_upscaler_stats">{statusText}</div>
            )}
            {open && (
                <div id="component_upscaler_menu" onKeyDown={e => e.stopPropagation()} onKeyUp={e => e.stopPropagation()}>
                    <div className="upscaler_head">
                        <strong>Upscaler</strong>
                        <button className="upscaler_close" title="Close" onClick={onClose}><i className="fa-solid fa-xmark"></i></button>
                    </div>

                    <div className="upscaler_label">Shader</div>
                    <label className="upscaler_opt">
                        <input type="radio" name="upscaler_shader" checked={settings.shader === 'off'} onChange={() => update({ shader: 'off' })} />
                        <span>Off</span>
                    </label>
                    {SHADERS.map(s => (
                        <label className="upscaler_opt" key={s.file}>
                            <input type="radio" name="upscaler_shader" checked={settings.shader === s.file} onChange={() => update({ shader: s.file })} />
                            <span>{s.label}<small>{s.note}</small></span>
                        </label>
                    ))}

                    <div className="upscaler_label">Apply</div>
                    <div className="upscaler_seg">
                        <button className={settings.mode === 'auto' ? 'on' : ''} onClick={() => update({ mode: 'auto' })}>Only when upscaling</button>
                        <button className={settings.mode === 'always' ? 'on' : ''} onClick={() => update({ mode: 'always' })}>Always</button>
                    </div>

                    <div className="upscaler_label">Scale to screen</div>
                    <div className="upscaler_seg">
                        <button className={settings.scaler === 'catmull' ? 'on' : ''} onClick={() => update({ scaler: 'catmull' })}>Sharp (Catmull-Rom)</button>
                        <button className={settings.scaler === 'bilinear' ? 'on' : ''} onClick={() => update({ scaler: 'bilinear' })}>Soft (bilinear)</button>
                    </div>

                    <div className="upscaler_label upscaler_label_row">
                        <span>Shader strength</span>
                        <span>{Math.round((settings.strength ?? 1) * 100)}%</span>
                    </div>
                    <input className="upscaler_range" type="range" min={0} max={2} step={0.05} value={settings.strength ?? 1}
                        disabled={settings.shader === 'off'}
                        title="100% = the shader as-is. Higher pushes its added detail further, lower blends back toward a plain upscale."
                        onChange={e => update({ strength: parseFloat(e.target.value) })}
                        onDoubleClick={() => update({ strength: 1 })}
                        onKeyDown={e => e.stopPropagation()} />

                    <label className="upscaler_opt upscaler_check">
                        <input type="checkbox" checked={settings.stats} onChange={e => update({ stats: e.target.checked })} />
                        <span>Show stats overlay</span>
                    </label>

                    <div className="upscaler_status">{statusText}</div>
                </div>
            )}
        </React.Fragment>
    )
}
