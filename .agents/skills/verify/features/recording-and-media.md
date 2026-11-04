# Recording, video export, and screenshots

Recording and media rendering capture terminal sessions from process startup into asciicast v3 `.cast` files, enforce the `Recorder` completion and publication statechart (`s0` through `s10`), render HiDPI PNG screenshots, and export offline MP4 videos through a bounded two-worker render pool (`F08` through `F11`).

## Sub-features

- `recorder-interval-save` (`F08`, `C1`, `C2`, `C4`, `Recorder` statechart `s0 -> s1 -> s4 -> s6 -> s9`) records startup output, resize events, and manual markers, stops the recording while the child stays alive, and publishes an interval `.cast` without a process-exit record (`SavedHasExtent`, `SavedIsDurable`).
- `recorder-process-save` (`F08`, `C1`, `C3`, `Recorder` statechart `s0 -> s2 -> s5 -> s7 -> s10`) records a session through natural process exit and clean output EOF, writing one terminal `"x"` record and atomically linking the final `.cast` file.
- `recorder-no-clobber-and-partial` (`F08`, `C1`, `C2`, `C3`, `Recorder` statechart `s0 -> s3` and `s4/s5 -> s3`) rejects existing destination files (`NoClobber`), reserves 128 bytes for the final control event (`PayloadLeavesControlSlot`), and leaves overloaded or aborted captures in `partial` without publishing a corrupt final file.
- `video-export-offline` (`F09`, `F11`, `W1`, `W2`) parses asciicast v3 offline without starting a relay daemon, plans constant-frame-rate timestamps with endpoint sampling, renders frames in planned order across workers, and encodes a valid MP4 via `ffmpeg`.
- `screenshot-render` (`F10`, `F11`, `W3`) renders terminal buffers to PNG files with bounded physical pixel limits, Retina `devicePixelRatio` scaling, and worker reservation tracking.

## How to get to it (user POV)

- Run `tuistory -s <name> --record <path.cast> -- <command>` or `TUISTORY_PORT=19953 bun src/cli.ts launch '<command>' -s <name> --record <path.cast> --background`.
- Run `tuistory -s <name> record mark <label>`, `record status --json`, or `record stop`.
- Run `tuistory -s <name> screenshot -o <path.png> --pixel-ratio 2`.
- Run `tuistory export <path.cast> -o <path.mp4> --fps 10` (runs locally without a relay daemon).
- Import `launchTerminal`, `exportRecording`, and `renderTerminalImage` from `tuistory`.

## Driving it with verify.ts

Preconditions:

- `dist/` is built with `bun run build`.
- Port `19953` is free (`verify.ts doctor --port 19953` reports `portState: "no-listener"`).
- `ffmpeg` and `ffprobe` are on `PATH` for MP4 encoding assertions (`doctor` reports their paths).

- **Interval recording (`s0 -> s1 -> s4 -> s6 -> s9`).** Launch a recorded session, emit output, resize, add a marker, and stop the interval while the child remains alive. Run `TUISTORY_PORT=19953 bun src/cli.ts launch "node -e \"console.log('REC_INTERVAL_READY'); setInterval(() => {}, 1000)\"" -s rec-int --record <scratch>/interval.cast --background`, `wait REC_INTERVAL_READY -s rec-int`, `resize 90 25 -s rec-int`, `record mark "step-1" -s rec-int`, `record status -s rec-int --json`, and `record stop -s rec-int`. `record stop` returns `{"kind":"saved","extent":"interval",...}`, the child remains `dead: false` in `sessions --json`, and `<scratch>/interval.cast` contains the asciicast v3 header, `"o"`, `"r"`, and `"m"` events with no `"x"` event (`C4`).
- **Process recording (`s0 -> s2 -> s5 -> s7 -> s10`).** Launch a recorded session that exits with code `0` after printing output, then close the session. Run `TUISTORY_PORT=19953 bun src/cli.ts launch "node -e \"console.log('REC_PROC_DONE')\"" -s rec-proc --record <scratch>/process.cast --background`, `wait REC_PROC_DONE -s rec-proc`, `record status -s rec-proc --json`, and `close -s rec-proc`. The status reaches `{"kind":"saved","extent":"process",...}` and the final event in `<scratch>/process.cast` is `["x", ...]` (`C1`, `C3`).
- **Destination no-clobber (`NoClobber`, `C3`).** Attempt to record to `<scratch>/process.cast` again. Run `TUISTORY_PORT=19953 bun src/cli.ts launch "echo NO" -s rec-clobber --record <scratch>/process.cast --background`. The command exits nonzero before spawning a child, and `<scratch>/process.cast` retains its original SHA-256 digest.
- **Screenshot rendering (`F10`, `F11`).** Capture a Retina PNG screenshot from `rec-int`. Run `TUISTORY_PORT=19953 bun src/cli.ts screenshot -s rec-int -o <scratch>/screen.png --pixel-ratio 2`. The file starts with the 8-byte PNG signature and its IHDR dimensions match the 2x physical render plan.
- **Offline MP4 export (`F09`, `F11`).** Stop the relay daemon, then export `<scratch>/interval.cast` to MP4. Run `TUISTORY_PORT=19953 bun src/cli.ts daemon-stop` and `TUISTORY_PORT=19953 bun src/cli.ts export <scratch>/interval.cast -o <scratch>/interval.mp4 --fps 10`. `export` succeeds while `portState` remains `no-listener`, and `ffprobe` confirms an H.264 video stream with positive frame count and duration.
- **Automated suite.** Run `bun .agents/skills/verify/scripts/verify.ts drive --feature recording --port 19953`. The helper executes all recording, overflow, screenshot, and offline export checks and saves the parsed cast and media probe artifacts.

## Gotchas

- `export <cast>` runs in the caller's process and must never start a relay daemon. Check `portState: "no-listener"` after export to confirm it did not spawn one.
- Recording paths passed to the CLI are resolved relative to the caller's working directory, not the session's `--cwd`.
- For recorded sessions, `session.close()` starts closure asynchronously; always await `session.closeAsync()` in library code or use CLI `close` so the `.cast` file finishes syncing and linking before inspection.
- Recorded sessions require the native PTY backend and reject Windows (`win32`).
