# Attach, request admission, and diagnostics

Attach, local request admission, and diagnostics cover the WebSocket `/attach` protocol v2 framing and subscription lifecycle (`F12`), the loopback HTTP middleware that blocks cross-origin browser requests and invalid `Host` headers before command execution or WebSocket upgrade (`F13`), and local CLI dispatch for `--help`, `--version`, and `logfile` (`F14`).

## Sub-features

- `diagnostics-local-dispatch` (`F14`) serves `--version` and `--help` locally without starting a daemon, reports the daemon log path via `logfile`, and survives invalid CLI arguments without crashing the relay daemon.
- `request-admission-boundary` (`F13`, `A3`) admits local requests with empty or absent `Origin`, matching loopback `Host` (`127.0.0.1`, `localhost`, or `[::1]`), and safe `Sec-Fetch-Site`, while rejecting browser `Origin`, mismatched `Host`, or `Sec-Fetch-Site: cross-site` with HTTP `403` before route handlers or WebSocket upgrades run.
- `attach-protocol-v2` (`F12`, `A1`, `A2`) negotiates `protocol: 2` over `ws://127.0.0.1:<port>/attach`, receives `{"type":"attached","protocol":2}` and replayed screen data envelopes, forwards framed `input` and `resize` messages, detaches cleanly without killing the session (`A1`), and releases all session subscriptions when the socket closes (`A2`).
- `attach-missing-and-closing` (`F12`) returns an `error` envelope and close code `1008` when attaching to an absent session, and delivers a `closing` control message when a session closes or restarts while attached.

## How to get to it (user POV)

- Run `tuistory --version`, `tuistory --help`, or `tuistory logfile`.
- Run `tuistory -s <name> attach` in an interactive terminal to open the OpenTUI client, press `Ctrl+C` twice within 450 ms to detach (`A1`), or press `Ctrl+X` twice within 450 ms to kill the session.
- Connect a WebSocket client to `ws://127.0.0.1:<port>/attach` and send `{"type":"attach","session":"<name>","cols":80,"rows":24,"protocol":2}`.

## Driving it with verify.ts

Preconditions:

- `dist/` is built with `bun run build`.
- Port `19953` is free (`verify.ts doctor --port 19953` reports `portState: "no-listener"`).

- **Local diagnostics without starting a daemon (`F14`).** Run `TUISTORY_PORT=19953 bun src/cli.ts --version` and `TUISTORY_PORT=19953 bun src/cli.ts --help`. Both exit `0` and `verify.ts doctor --port 19953` confirms `portState: "no-listener"`.
- **HTTP and WebSocket admission boundary (`F13`, `A3`).** Start a session on port `19953`, then send HTTP and WebSocket upgrade requests with `Origin: https://evil.example`, `Host: evil.example:19953`, and `Sec-Fetch-Site: cross-site`. Each request returns HTTP `403 Forbidden`, and `sessions --json` confirms no unauthorized command executed.
- **WebSocket attach protocol 2 replay, input, resize, and detach (`F12`, `A1`, `A2`).** Open a WebSocket to `ws://127.0.0.1:19953/attach`, send `{"type":"attach","session":"proto-demo","cols":80,"rows":24,"protocol":2}`, await `{"type":"attached","protocol":2}`, send `{"type":"input","data":"hello_attach\\n"}` and `{"type":"resize","cols":100,"rows":30}`, observe the echoed `"data"` envelope, and close the socket. `sessions --json` confirms `proto-demo` is still alive (`dead: false`, `cols: 100`, `rows: 30`), proving detach does not kill the child (`A1`) and repeated attach does not duplicate output (`A2`).
- **Absent session attach error (`F12`).** Open a WebSocket to `ws://127.0.0.1:19953/attach` and request `{"type":"attach","session":"missing-session","protocol":2}`. The server sends `{"type":"error","message":"Session \"missing-session\" not found"}` and closes with code `1008`.
- **Automated suite.** Run `bun .agents/skills/verify/scripts/verify.ts drive --feature protocols --port 19953`. The helper records all HTTP status codes, WebSocket frames, and post-detach session states in `evidence.json`.

## Gotchas

- Legacy WebSocket clients that omit `protocol: 2` receive raw unframed output strings and can confuse PTY output resembling JSON with control events (`B10`). Always send `protocol: 2` when driving `/attach`.
- `tuistory attach` launches an interactive fullscreen OpenTUI interface and requires a real TTY. In automated runs, drive `/attach` via WebSocket protocol 2 or spawn `attach` inside a dedicated PTY.
- Double `Ctrl+X` sends a kill message and exits the client after 100 ms without waiting for child exit confirmation. Verify child termination through `sessions --json` afterward.
