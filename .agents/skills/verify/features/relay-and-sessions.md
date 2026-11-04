# Relay and named sessions

Relay and named-session management starts or reuses the background relay daemon on a local TCP port, serializes daemon replacement under a ticket lock, and manages named PTY sessions across launch, reuse, inspection, restart, close, and daemon shutdown (`F01` and `F02`).

## Sub-features

- `relay-cold-start` (`F01`, `R2`, `R3`, `R4`, `Relay` statechart `s0 -> s1 -> s3 -> s7 -> s8 -> s2`) spawns a new daemon when the port has no listener, writes the diagnostic PID file after bind, and reaches `Use compatible daemon`.
- `relay-reuse-compatible` (`F01`, `R1`, `Relay` statechart `s0 -> s2`) reuses a healthy compatible daemon on the unlocked HTTP fast path without killing existing sessions.
- `session-launch-and-reuse` (`F02`, `N1`) launches a named session with custom dimensions, working directory, and environment variables, reuses a live session under the same name, and joins duplicate concurrent launches.
- `session-restart-identity` (`F02`, `N2`) restarts a named session while preserving `TUISTORY_SESSION_ID`, command, working directory, dimensions, and environment across a fresh process lifetime.
- `session-replace-dead` (`F02`) retains a dead session's output for inspection until a new launch under the same name closes and replaces it.
- `session-close-and-daemon-stop` (`F01`, `F02`, `N3`, `Relay` statechart `s6 -> s7`) closes individual sessions, rejects new creation during shutdown (`N3`), or stops the daemon under the lifecycle lock and confirms the port is free.

## How to get to it (user POV)

- Run `tuistory -s <name> -- <command>` with the installed binary or `TUISTORY_PORT=19953 bun src/cli.ts launch '<command>' -s <name> --background` during local verification.
- Run `tuistory sessions --json` to list active and exited sessions on the daemon.
- Run `tuistory -s <name> restart` to restart a session in place while keeping its logical session ID.
- Run `tuistory -s <name> close` to terminate and remove a single session.
- Run `tuistory daemon-stop` to stop the relay daemon and free its TCP port.

## Driving it with verify.ts

Preconditions:

- `bun .agents/skills/verify/scripts/verify.ts doctor --port 19953` reports `portState: "no-listener"`.
- `dist/cli.js` is built and up to date with `src/`.

- **Cold relay startup and session launch.** Start a session on an empty port. Run `TUISTORY_PORT=19953 bun src/cli.ts launch "node -e \"console.log('READY:' + process.pid + ':' + process.env.TUISTORY_SESSION_ID); setInterval(() => {}, 1000)\"" -s life-demo --cols 90 --rows 28 --background`. Exit code is `0`, `sessions --json` lists `life-demo` with `cols: 90`, `rows: 28`, and `dead: false`, and the `Relay` startup path transitions through `s0 -> s1 -> s3 -> s7 -> s8 -> s2`.
- **Compatible daemon and live session reuse.** Repeat the launch command against the running daemon and live session name. Run `TUISTORY_PORT=19953 bun src/cli.ts launch "echo SHOULD_NOT_RUN" -s life-demo --background` and `TUISTORY_PORT=19953 bun src/cli.ts read -s life-demo --all`. The daemon PID and child PID remain unchanged (`R1`), and `SHOULD_NOT_RUN` never appears in the session buffer (`N1`).
- **Session restart with preserved logical identity.** Restart the session. Run `TUISTORY_PORT=19953 bun src/cli.ts restart -s life-demo` and `TUISTORY_PORT=19953 bun src/cli.ts read -s life-demo --all`. The new output prints a different child `process.pid` and the exact same `TUISTORY_SESSION_ID` (`N2`).
- **Dead session retention and replacement.** Launch a short-lived command under a new name, let it exit, inspect it, and replace it. Run `TUISTORY_PORT=19953 bun src/cli.ts launch "node -e \"console.log('ONCE:' + process.env.TUISTORY_SESSION_ID)\"" -s dead-demo --background`, inspect `sessions --json` (`dead: true`), then launch again with `-s dead-demo`. The replacement starts with a fresh `TUISTORY_SESSION_ID`.
- **Session close and daemon stop.** Close `life-demo` and stop the relay daemon. Run `TUISTORY_PORT=19953 bun src/cli.ts close -s life-demo` and `TUISTORY_PORT=19953 bun src/cli.ts daemon-stop`. `sessions --json` removes `life-demo` before daemon shutdown, and `verify.ts doctor --port 19953` reports `portState: "no-listener"`.
- **Automated suite.** Run `bun .agents/skills/verify/scripts/verify.ts drive --feature lifecycle --port 19953`. The command writes command and state artifacts under `tmp/verification/` and asserts every `F01` and `F02` check above.

## Gotchas

- The relay daemon keeps compiled code in memory across CLI calls. Always run `daemon-stop` on the target port before manual testing after a code edit.
- Bun strips `--` from `process.argv`. Use `launch '<command>'` whenever invoking `bun src/cli.ts` directly.
- Never run `daemon-stop` against port `19977` during automated verification because that port belongs to the user's live sessions.
- PID files are diagnostic only (`R3`). Always check actual TCP listeners on `127.0.0.1:<port>` to confirm whether the port is free.
