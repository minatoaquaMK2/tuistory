# Feature map

This map connects tuistory's user features to implementation, test evidence, state, and candidate formal properties. It describes the working tree based on `2bc5b367bda0ab0da8009e0141d2345317c8f78e`, including the [bug audit repairs](audit.md). Package version remains `0.12.0`.

Source inspection establishes current behavior. Test links establish that a check exists, not that it ran on every platform. The [starter models and statecharts](statecharts.md) check bounded abstractions. They do not prove the TypeScript implementation. All properties below remain candidate implementation obligations.

The [concurrent lifecycle experiment](../verification/lifecycle/README.md) adds independent requirements, implementation models, refinement checks, and real-process counterexample replays. It records two further repairs and the limits that remain open.

The library creates a `Session` in the caller's process. Most CLI commands instead operate on sessions retained by a local daemon. PTY output updates the terminal, retained output, recording, subscribers, and waiters. Process exit, output completion, terminal disposal, and recording publication are separate events. [Library entry](../../src/index.ts#L8), [client routing](../../src/cli.ts#L2400), [session output](../../src/session.ts#L330).

## Feature index

| ID | User capability | State owner | Verification target |
| --- | --- | --- | --- |
| F01 | [Start or reuse the relay](lifecycle.md) | Port, version, PID and restart lock | Compatible daemon reuse, safe replacement, lock reclamation |
| F02 | [Launch, list, close and restart named sessions](lifecycle.md) | `sessions`, `pendingSessions`, session identity | Name ownership, shutdown admission, replacement identity |
| F03 | [Create a library terminal and select its PTY backend](terminal.md) | `Session`, runtime-specific PTY | Readiness, spawn cleanup, backend contracts |
| F04 | [Type, press keys, click and scroll](terminal.md) | PTY input and terminal coordinates | Write guards, key encoding, unique text selection |
| F05 | [Inspect terminal text and retained output](terminal.md) | Terminal, output chunks, read cursor | Snapshot semantics, consumption, eviction |
| F06 | [Wait for output, text, idle or exit](terminal.md) | Timers, resolver lists, exit and output state | Settlement, timeout meanings, output tail |
| F07 | [Resize, kill and close a terminal](terminal.md) | Geometry, process group, disposal and cleanup | Idempotent close, exit observation, cleanup ownership |
| F08 | [Record a session and control recording](recording.md) | Recorder queue, lifecycle and filesystem publication | Prefix preservation, no overwrite, saved versus partial |
| F09 | [Export a recording to video](recording.md) | Parser, frame plan, encoder and output file | Timing, ordered frames, successful publication |
| F10 | [Render PNG screenshots](recording.md) | Raster plan and shared screenshot admission | Pixel limits, geometry, admission lifetime |
| F11 | [Run isolated render workers](recording.md) | Pool state, worker slot and job identity | Exactly owned jobs, first failure, shutdown settlement |
| F12 | [Attach interactively or over WebSocket](protocols.md) | Socket, subscriptions and attach UI | Replay, detach, kill and notification ordering |
| F13 | [Admit local requests and reject browser requests](protocols.md) | HTTP middleware and route order | Rejection before command execution or upgrade |
| F14 | [Read diagnostics, help and version](protocols.md) | CLI parsing and relay log | Local handling, error propagation, command discovery |

## CLI entry points

The installed CLI uses `tuistory -s demo -- <command>`. Local development uses `bun src/cli.ts launch '<command>'` because Bun strips `--`. Session operations require `-s`. Help and version are parser options, not command registrations.

| Registration | Feature | Implementation | Existing test example or gap |
| --- | --- | --- | --- |
| `-- <command>` | F02 | [root command](../../src/cli.ts#L1620) | [root launch](../../src/cli.test.ts#L315) |
| `launch [command]` | F02 | [hidden alias](../../src/cli.ts#L522) | [launch workflow](../../src/cli.test.ts#L175) |
| `sessions` | F02 | [listing](../../src/cli.ts#L1521) | [multiple sessions](../../src/cli.test.ts#L330) |
| `close` | F02, F07 | [close reservation](../../src/cli.ts#L1350) | [missing session](../../src/cli.test.ts#L395) |
| `restart` | F02 | [restart](../../src/cli.ts#L1392) | [identity preservation](../../src/cli.test.ts#L1183) |
| `snapshot` | F05 | [screen text](../../src/cli.ts#L533) | [workflow](../../src/cli.test.ts#L175) |
| `read` | F05 | [retained output](../../src/cli.ts#L628) | [non-consuming all](../../src/cli.test.ts#L916) |
| `type <text>` | F04 | [typing](../../src/cli.ts#L863) | [interactive workflow](../../src/cli.test.ts#L175) |
| `press <key> [...keys]` | F04 | [key validation](../../src/cli.ts#L904) | [invalid keys](../../src/cli.test.ts#L413) |
| `click <pattern>` | F04 | [text click](../../src/cli.ts#L960) | Library tests exist; dedicated CLI test not identified |
| `click-at <x> <y>` | F04 | [coordinate click](../../src/cli.ts#L1012) | Dedicated CLI test not identified |
| `scroll <direction> [lines]` | F04 | [wheel input](../../src/cli.ts#L1156) | Dedicated CLI test not identified |
| `wait <pattern>` | F06 | [text wait](../../src/cli.ts#L1052) | [final output](../../src/cli.test.ts#L842) |
| `wait-idle` | F06 | [idle wait](../../src/cli.ts#L1117) | Library idle tests exist |
| `resize <cols> <rows>` | F07 | [resize](../../src/cli.ts#L1212) | Library recording geometry tests exist |
| `capture-frames <key> [...keys]` | F05 | [sample snapshots](../../src/cli.ts#L1249) | Dedicated test not identified |
| `record mark <label>` | F08 | [marker](../../src/cli.ts#L1298) | Recorder API tests exist |
| `record status` | F08 | [status](../../src/cli.ts#L1314) | Recorder API tests exist |
| `record stop` | F08 | [stop interval](../../src/cli.ts#L1327) | [shutdown recording](../../src/cli.test.ts#L598), API stop tests |
| `export <cast>` | F09 | [definition](../../src/cli.ts#L1340), [client execution](../../src/cli.ts#L2415) | Export API tests exist; CLI invocation test not identified |
| `screenshot` | F10 | [PNG command](../../src/cli.ts#L747) | Render API tests exist; CLI invocation test not identified |
| `attach` | F12 | [client execution](../../src/cli.ts#L2298) | [WebSocket output](../../src/cli.test.ts#L1285); UI timing untested |
| `daemon-stop` | F01 | [stop path](../../src/cli.ts#L2381) | [orphan daemon](../../src/cli.test.ts#L665) |
| `logfile` | F14 | [log path](../../src/cli.ts#L1565) | Dedicated output assertion not identified |

## Package entry points

The root entry exports `Session`, `launchTerminal`, `renderTerminalImage`, and `exportRecording`. Its exported types are `LaunchOptions`, `RecordedLaunchOptions`, `TextOptions`, `Key`, `RecordOptions`, `RecordingHandle`, `RecordingStatus`, `ExportRecordingOptions`, `ScreenshotOptions`, and `ExportRecordingResult`. [Export declarations](../../src/index.ts#L1).

`tuistory/src` points at the same source entry. `tuistory/pty` conditionally selects the Bun or Node adapter and exports `spawn`, `IPty`, and `SpawnOptions`. `IPty` exposes `pid`, `write`, `resize`, `kill`, `onData`, and `onExit`. `Recorder`, `createSession`, parser helpers, and worker-pool helpers are internal module exports, not root API exports. [Package exports](../../package.json#L13), [Node adapter](../../src/pty-node.ts#L4), [Bun adapter](../../src/pty-bun.ts#L3).

## Verification priorities

| Priority | Feature and property IDs | Next model boundary | Why this boundary matters |
| --- | --- | --- | --- |
| P0 | F01, R1 to R4 | Two clients, bakery tickets, owner death, port owner, stop/start | Restart destroys all in-memory sessions; local-filesystem ordering and crash interleavings require a stronger model |
| P0 | F02, N1 to N3 | One name, two requests, pending launch/close/restart, shutdown | Async preparation and replacement can cross ownership changes |
| P0 | F07 and F08, S1 to S4, C1 to C4 | Exit, EOF, close, recorder and filesystem operations | Process exit does not establish complete output or durable publication |
| P1 | F11, W1 to W3 | Two slots, two jobs, replies, failure, close | Out-of-order replies must not reorder frames or leak admission |
| P1 | F05 and F06, O1 to O3 | Retained chunks, cursor, wait predicate and timer | Reads and waits expose different completion meanings |
| P1 | F12 and F13, A1 to A3 | Handshake, subscriptions, socket closure, request admission | Transport tests do not cover UI timing or every repeated handshake |
| P2 | F04, F09–F10 | Key encoding, temporal transforms, pixel limits | Pure transformations suit property-based checks; pixel fidelity still needs image tests |

The property IDs are defined in the linked feature documents. The [statechart record](statecharts.md) identifies exactly which reduced properties were checked and what remains excluded.

## Existing test boundaries

Use `bun test` for Bun and `bun run test:node` for the Node suite. The Node command rebuilds `dist` before Vitest. Vitest excludes the CLI suite, and the CLI suite itself launches Bun. Do not label CLI behavior as Node-tested. [Scripts](../../package.json#L27), [Vitest configuration](../../vitest.config.ts#L13), [CLI runner](../../src/cli.test.ts#L17).

`session-close.test.ts` uses Linux-only fixtures. Some recording tail cases also require Linux. FFmpeg gates video tests and some image assertions. A skipped case provides no runtime evidence for that environment. [Session platform gate](../../src/session-close.test.ts#L9), [recording tail gate](../../src/recording.test.ts#L16), [FFmpeg gate](../../src/recording.test.ts#L345).

The CLI test suite manages its daemon on port `19951`. Manual smoke tests must first run both daemon-stop commands in [AGENTS.md](../../AGENTS.md). Stopping the default daemon destroys user sessions. This documentation task does not require a manual daemon restart.

## Maintenance

`bun scripts/check-feature-map.mjs` checks that every CLI registration, public `Session` member, and root export is mentioned, and that local links resolve. It checks inventory, not semantic accuracy or proof correspondence. The PTY adapter and protocol inventory remain explicit review obligations.

When behavior changes, update the feature entry, source/test anchors, property assumptions, and affected models together. Advance the source revision only after checking correspondence. Preserve failed checks as evidence; a model counterexample requires replay against the real implementation before being called a product bug.
