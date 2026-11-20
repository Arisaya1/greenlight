# Greenlight debug harness

Runs the dev build (`nextron dev`) under a detached supervisor that records everything to `dbg/logs/`.

```
node dbg/gl.mjs start            # boot app (~15s), logs begin
node dbg/gl.mjs status
node dbg/gl.mjs since 90s        # everything from the last 90 seconds (the main one)
node dbg/gl.mjs errors 10m       # errors/warnings/ws/http failures only
node dbg/gl.mjs tail 100
node dbg/gl.mjs grep <regex> [n]
node dbg/gl.mjs mark "clicked Start Stream"   # drop a marker into the log
node dbg/gl.mjs reload           # full relaunch (also revives the app after you close its window)
node dbg/gl.mjs stop
```

## What is captured (`logs/combined.log`, timestamped local time)

| tag | source |
|---|---|
| `m:stderr` | main process `debug()` output (`greenlight:*`, xal-node, xbox-webapi, ...) |
| `m:log` / `m:info` | main process `console.*` |
| `m:exception` / `r:exception` | uncaught exceptions |
| `r:log` `r:error` `r:warn` ... | renderer console (incl. xbox-xcloud-player) |
| `r:net` / `r:ws` / `r:nav` | HTTP >= 400, failed requests, websocket open/close/error, navigations |
| `main:out` / `main:err` | nextron + next dev output |
| `sup` / `m:sup` / `r:sup` | harness events (attach, relaunch) |
| `MARK` | markers from `gl.mjs mark` |

`main.log` and `renderer.log` hold the per-process subsets. Old runs rotate into `logs/archive/<timestamp>/`.
Tokens and long blobs are redacted before hitting disk.

## How it works

- nextron launches electron with `--remote-debugging-port=9222 --inspect-brk=9292`. The supervisor attaches to the renderer
  (CDP, port 9222) and to the main process (node inspector, 9292) because electron is spawned detached and its stdout never reaches a pipe.
- `--inspect-brk` pauses the app until the supervisor attaches, so startup logs are not missed.
- Editing `packages/desktop/main/*` makes nextron crash on Windows (it SIGTERMs electron and execa throws). The supervisor catches that
  and relaunches (~15s). Renderer edits hot-reload through Next HMR with no restart.
- Dev profile lives in `%APPDATA%\greenlight-desktop (development)` (config.json copied from the installed app so you are signed in).
- Only processes under this checkout are ever killed. The installed `C:\Program Files\Greenlight\Greenlight.exe` is untouched.
