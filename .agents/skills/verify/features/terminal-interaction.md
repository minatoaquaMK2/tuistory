# Terminal interaction and completion

Terminal automation creates an in-process or daemon-backed PTY session, sends keystrokes and mouse events, reads incremental or full output buffers, waits for text, idle, or process exit, and enforces the `Session` exit and close statechart (`F03` through `F07`).

## Sub-features

- `terminal-create-and-input` (`F03`, `F04`) creates a terminal session and drives `type`, `press`, `sendKey`, `writeRaw`, `click`, `clickAt`, `scrollUp`, and `scrollDown`.
- `terminal-read-cursor` (`F05`, `O1`) consumes unread chunks once with `read`, preserves the cursor on `read --all` and `getRawOutput`, and captures styled or trimmed screen snapshots with `snapshot` and `captureFrames`.
- `terminal-waits` (`F06`, `O2`, `O3`) settles `wait` (literal and regex without mutating caller `lastIndex`), `wait-idle`, `waitForData`, and `waitForExit`, keeping trailing output eligible for text waits after main-process exit.
- `terminal-resize-and-guards` (`F07`, `S1`) resizes positive integer dimensions and rejects PTY writes or resizes after observed process exit or session closure (`NoWriteAfterCloseOrExit`).
- `session-statechart-close` (`F07`, `S2`, `S3`, `S4`, `Session` statechart `s0 -> s1 -> s3 -> s6 -> s7` and `s0 -> s2 -> s6 -> s7`) fires `onClosing` listeners once (`CloseNotifiesOnce`), preserves real exit status across disposal (`S3`), requires process exit before EOF (`EOFRequiresExit`), and attempts generated `TERMCAST` database cleanup only after real exit (`CleanupRequiresExit`).

## How to get to it (user POV)

- Run `tuistory -s <name> type <text>`, `press <key> [...keys]`, `click <pattern>`, `click-at <x> <y>`, or `scroll <up|down> [lines]`.
- Run `tuistory -s <name> read`, `read --all`, `snapshot --trim`, or `capture-frames <key> --count <n> --interval <ms>`.
- Run `tuistory -s <name> wait <pattern>`, `wait-idle`, `resize <cols> <rows>`, or `close`.
- Import `launchTerminal` and `Session` from `tuistory` for direct programmatic control in Bun or Node.

## Driving it with verify.ts

Preconditions:

- `dist/` is built with `bun run build`.
- Port `19953` is free (`verify.ts doctor --port 19953` reports `portState: "no-listener"`).

- **Interactive input and wait settlement.** Launch an interactive REPL session and drive typing and key chords. Run `TUISTORY_PORT=19953 bun src/cli.ts launch "node -e \"process.stdin.setEncoding('utf8'); console.log('PROMPT_READY'); process.stdin.on('data', d => console.log('ECHO:' + d.trim()))\"" -s term-demo --background`, then `wait PROMPT_READY -s term-demo`, `type "alpha" -s term-demo`, `press enter -s term-demo`, and `wait "ECHO:alpha" -s term-demo`. The wait resolves as soon as `ECHO:alpha` renders (`O2`).
- **Incremental cursor versus non-consuming read.** Read the buffer twice and compare with `--all`. Run `TUISTORY_PORT=19953 bun src/cli.ts read -s term-demo`, then run `read -s term-demo` a second time, and then `read -s term-demo --all`. The first `read` returns `PROMPT_READY` and `ECHO:alpha`, the second `read` returns empty output, and `read --all` still returns the complete history without advancing the cursor (`O1`).
- **Resize, mouse click, scroll, and frame sampling.** Resize the terminal and exercise click, scroll, and frame capture. Run `TUISTORY_PORT=19953 bun src/cli.ts resize 100 30 -s term-demo`, `click "PROMPT_READY" -s term-demo`, `click-at 2 0 -s term-demo`, `scroll down 2 -s term-demo`, and `capture-frames enter -s term-demo --count 2 --interval 15`. `sessions --json` reports `cols: 100` and `rows: 30`, and `capture-frames` outputs a two-element JSON array of snapshots.
- **Session statechart transitions and invariants.** Drive `Session` across `s0` (`Running`), `s1` (`Exited; reading output tail`), `s3` (`Exited; output complete`), `s6` (`Closing; completion settled`), and `s7` (`Disposed; cleanup attempted`), plus reentrant `closeAsync()`. Run `bun .agents/skills/verify/scripts/verify.ts drive --feature terminal --port 19953`. The run verifies that `onClosing` fires once (`S2`), writes and resizes after exit or close throw (`S1`), `waitForExit` retains the real exit code after disposal (`S3`), and generated `TERMCAST` database files are removed only after real process exit (`S4`).

## Gotchas

- `read` advances a single session-wide cursor shared by all CLI callers. Use `read --all` or `snapshot` when inspecting state without consuming unread output.
- `wait-idle` resolves when the terminal is quiet or when its timeout expires. A `wait-idle` return alone does not prove new output arrived; pair it with `wait <pattern>` or `snapshot`.
- `click <pattern>` searches only the visible viewport rows and rejects multiple matches unless `--first` is passed.
- Modifier-only key chords can be a no-op write; test write guards (`S1`) with actual printable keys or `resize`.
