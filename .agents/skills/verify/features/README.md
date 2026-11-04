# Tuistory verification feature map

This directory is the maintained source for driving Tuistory's user-facing surfaces and checking them against the [repository feature map](../../../../docs/feature-map/README.md) (`F01` through `F14`) and the [Relay, Session, and Recorder statecharts](../../../../docs/feature-map/statecharts.md). Read this index first, then open the matching feature file for the exact commands, statechart paths, and assertions.

## Baseline preconditions

- Build `dist/` with `bun run build` before driving the CLI or library.
- Reserve an isolated verification port with `TUISTORY_PORT=19953` (or `--port <port>`). Never use user port `19977`, CLI test port `19951`, or relay-lifecycle test port `19952`.
- Run `bun .agents/skills/verify/scripts/verify.ts doctor --port 19953` and require `portState: "no-listener"` and `featureMapCheck.ok: true` before starting a drive.
- Use a disposable scratch directory for every session's working directory and recording output while keeping proof artifacts under `tmp/verification/<run>/`.
- Never drive a relay daemon that was not started by the current verification run.

## Driving conventions

- Start each feature recipe from a clean `no-listener` port unless the step explicitly tests compatible daemon reuse.
- When running the CLI through Bun (`bun src/cli.ts`), use `launch '<command>'` because Bun strips `--` from `process.argv`. Use `tuistory -- <command>` only when invoking the built binary directly.
- Pass `-s <session>` explicitly on every session command.
- Wait for deterministic terminal text (`wait`) or quietness (`wait-idle`) instead of fixed sleeps.
- Tear down the isolated daemon in cleanup while leaving the evidence directory untouched.

## Proof and skip reporting

- Capture both the action and the resulting state for every sub-feature.
- CLI proof records the exact command argv, stdout, stderr, and exit code alongside a second observation (`sessions --json`, `snapshot --json`, `record status --json`, or output files on disk).
- Statechart proof names the projected chart states and arrows from [docs/feature-map/statecharts.md](../../../../docs/feature-map/statecharts.md) and separates live runtime observations from bounded TLC model checks.
- Media proof checks file headers, decoded dimensions, and `ffprobe` stream metadata on disk.
- If an external tool (`ffmpeg`, `ffprobe`, `java`, or `tla2tools.jar`) is absent, report the affected sub-feature as `skipped` with the missing prerequisite. Never report a skipped path as verified through another entry point.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses four H2 sections in this order:

1. `Sub-features` lists short IDs mapped to `F01` through `F14`, candidate properties (`R1` to `R4`, `N1` to `N3`, `O1` to `O3`, `S1` to `S4`, `C1` to `C4`, `W1` to `W3`, `A1` to `A3`), and statechart transitions.
2. `How to get to it (user POV)` lists every user-facing CLI, library, or protocol entry point.
3. `Driving it with verify.ts` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Relay and named sessions](./relay-and-sessions.md) covers `F01` and `F02`, the `Relay` startup statechart (`s0` through `s8`), properties `R1` through `R4`, and properties `N1` through `N3`.
- [Terminal interaction and completion](./terminal-interaction.md) covers `F03` through `F07`, the `Session` exit and close statechart (`s0` through `s7`), properties `O1` through `O3`, and properties `S1` through `S4`.
- [Recording, video export, and screenshots](./recording-and-media.md) covers `F08` through `F11`, the `Recorder` completion and publication statechart (`s0` through `s10`), properties `C1` through `C4`, and properties `W1` through `W3`.
- [Attach, request admission, and diagnostics](./attach-and-boundaries.md) covers `F12` through `F14`, WebSocket protocol 2 framing, local HTTP origin and host guards, and properties `A1` through `A3`.
