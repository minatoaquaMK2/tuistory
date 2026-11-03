# Attach, request admission and diagnostics

## F12. Attach

The client handles `attach` locally after ensuring the relay. Node launches the Bun-backed OpenTUI interface. The WebSocket handshake supplies session name, terminal dimensions, and optional protocol version. Protocol 2 acknowledges attach before sending data envelopes and lifecycle controls. Clients without a protocol field retain the legacy raw stream. The daemon replays retained output and subscribes to later output. Natural exit leaves terminal content available for inspection. [Client entry](../../src/cli.ts#L2294), [server handshake](../../src/cli.ts#L1897), [UI entry](../../src/attach-tui.tsx#L370).

| Event | Client/daemon behavior | Observable result |
| --- | --- | --- |
| Attach existing session | Optional resize, replay, one owned binding | Existing screen and later output appear; repeated attach does not duplicate subscriptions |
| Attach absent session | Error control message and close code 1008 | Clear missing-session error |
| Input or resize | Protocol 2 wraps text in an input message; legacy clients send raw text | PTY receives input or new dimensions |
| Paste | Decode OpenTUI paste bytes without dropping a leading U+FEFF and flush any pending Ctrl key | Unicode paste reaches the PTY; child bracketed-paste mode is not negotiated |
| Process exit | Send exit information | UI retains a dead-session status |
| Session close/restart | Send closing reason before socket close | UI distinguishes lifecycle closure |
| Double Ctrl+C within 450 ms | Close local socket and renderer | Detach; process keeps running |
| Double Ctrl+X within 450 ms | Send kill and exit after 100 ms | Kill is requested; client does not await an acknowledgment |
| Single Ctrl+C or Ctrl+X | Forward after double-key window | Application receives the original control key |

[UI message handling](../../src/attach-tui.tsx#L161), [double-key handling](../../src/attach-tui.tsx#L287), [detach and kill](../../src/attach-tui.tsx#L389).

| ID | Candidate property | Current evidence and gap |
| --- | --- | --- |
| A1 | Detach does not kill; kill targets the selected session | [Transport kill](../../src/cli.test.ts#L1367); UI key timing and kill acknowledgment are separate |
| A2 | Socket closure releases every subscription and repeated handshakes cannot retain stale output sources | [Real reattach and switch tests](../../src/attach.test.ts) cover data, exit and closing ownership |
| A3 | Rejected requests cannot execute commands or upgrade WebSockets | Middleware precedes routes; tests cover Origin and invalid Host cases |

Transport tests cover [output replay/stream](../../src/cli.test.ts#L1285), [missing session](../../src/cli.test.ts#L1319), [input forwarding](../../src/cli.test.ts#L1340), and [kill](../../src/cli.test.ts#L1367). [Attach regressions](../../src/attach.test.ts) drive real WebSockets and the TUI for Unicode paste, control-looking output, and pending/delayed Ctrl keys. Clipboard behavior, pending keys during exit, and renderer cleanup still need broader checks. Clipboard depends on `pbcopy`, `xclip`, or `clip`; command failures are ignored. [Clipboard](../../src/attach-tui.tsx#L18).

## F13. Local request boundary

The relay binds `127.0.0.1`. Middleware runs before every route. The actual admission predicate permits an absent or empty Origin. Host, ignoring case, must match the selected port with `127.0.0.1`, `localhost`, or `[::1]`. `Sec-Fetch-Site` must be absent, `same-origin`, or `none`. [Predicate](../../src/cli.ts#L1830), [middleware placement](../../src/cli.ts#L1870).

| Endpoint | Inputs | Result and state owner |
| --- | --- | --- |
| `GET /version` | Admission headers | Package version |
| `GET /sessions` | Admission headers | Session metadata list |
| `POST /cli` | `{argv, cwd, env}` | `{stdout, stderr, exitCode}`; rejects work during shutdown |
| WebSocket `/attach` | Attach, resize and kill controls; protocol 2 input envelopes or legacy raw text | Framed or legacy PTY stream and lifecycle controls |

[Version and sessions](../../src/cli.ts#L1879), [CLI endpoint](../../src/cli.ts#L2013), [WebSocket cleanup](../../src/cli.ts#L2005).

Existing tests cover [Origin rejection](../../src/cli.test.ts#L1413), [Host rejection](../../src/cli.test.ts#L1436), [rejected upgrade](../../src/cli.test.ts#L1462), and [legitimate upgrade](../../src/cli.test.ts#L1501). Complete `Sec-Fetch-Site`, Host-case, and request-body matrices were not identified. These are test gaps, not demonstrated access-control defects.

## F14. Diagnostics and local dispatch

Help and version return locally. Offline export also runs without a daemon. Other diagnostic commands follow normal routing. `logfile` reports the relay log location. Relay startup failures print a log tail. Invalid commands become a nonzero result without intentionally terminating the daemon. [Local dispatch](../../src/cli.ts#L2396), [log path](../../src/cli.ts#L1565), [log tail](../../src/cli.ts#L2146).

Tests cover [help](../../src/cli.test.ts#L137), [version](../../src/cli.test.ts#L167), [invalid command survival](../../src/cli.test.ts#L437), and [per-command help](../../src/cli.test.ts#L988). The root README debugging example uses the implemented `logfile` command. This map covers every source registration. [README example](../../README.md#L370).

Protocol 2 fixes control/data ambiguity for upgraded clients. Old clients keep their original ambiguous protocol. A new TUI rejects missing or invalid negotiation rather than interpreting raw output as controls. Wire schemas live in [attach-protocol.ts](../../src/attach-protocol.ts).
