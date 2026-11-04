---
name: verify
description: Drive Tuistory's CLI, library, WebSocket protocol, and bounded TLA+ statecharts on an isolated relay port, capture action and result evidence, and check feature-map invariants. Use when verifying a change to Tuistory.
---

# Verify Tuistory

Use this skill to verify user-facing behavior against the [repository feature map](../../../docs/feature-map/README.md) and the [Relay, Session, and Recorder statecharts](../../../docs/feature-map/statecharts.md). Read the [verification feature map](features/README.md) first, then pick the scope that covers your change. For concurrent relay lock and signal-escalation changes, also run the [relay-lifecycle formal skill](../relay-lifecycle/SKILL.md).

## Launch

Install dependencies with Bun and build `dist/` before driving the CLI or library, because `tuistory/pty` and the Node test path resolve compiled files in `dist/`.

```bash
bun install
bun run build
bun .agents/skills/verify/scripts/verify.ts doctor
```

Tuistory is a short-lived CLI client backed by a detached local relay daemon. Each verification drive sets `TUISTORY_PORT=19953` by default so it never touches the user daemon on port `19977`, the CLI test suite on port `19951`, or the relay lifecycle suite on port `19952`. A session is ready only when its child process prints its startup token and `sessions --json` lists the session as live. Port binding alone does not prove readiness.

## Doctor

Run the read-only health check before driving any feature and after any unexpected failure.

```bash
bun .agents/skills/verify/scripts/verify.ts doctor --port 19953
```

`doctor` checks the checkout root, Git revision, package version, compiled `dist/cli.js` artifact, Bun and Node runtimes, `ffmpeg` and `ffprobe` binaries, `java` and the pinned `tla2tools.jar` checksum, feature-map inventory links via `scripts/check-feature-map.mjs`, and the state of the target port. When no verification run is active, `doctor` expects `no-listener` on port `19953`. It never starts or stops a daemon.

## Drive

Run the executable verification script for the touched feature group, or run `all` to exercise every feature file and all three statechart models in one isolated pass.

```bash
bun .agents/skills/verify/scripts/verify.ts drive --feature lifecycle
bun .agents/skills/verify/scripts/verify.ts drive --feature terminal
bun .agents/skills/verify/scripts/verify.ts drive --feature recording
bun .agents/skills/verify/scripts/verify.ts drive --feature protocols
bun .agents/skills/verify/scripts/verify.ts drive --feature models
bun .agents/skills/verify/scripts/verify.ts drive --feature all
```

- `lifecycle` drives [F01 and F02](features/relay-and-sessions.md) and exercises the `Relay` startup statechart (`s0` `Probe port` through `s8` `Wait for new daemon`), compatible daemon reuse (`R1`), free-port spawn (`R2`), diagnostic PID ownership (`R3`), lifecycle lock serialization (`R4`), named session reuse (`N1`), restart identity preservation (`N2`), shutdown creation guard (`N3`), and `daemon-stop`.
- `terminal` drives [F03 through F07](features/terminal-interaction.md) and exercises the `Session` exit and close statechart (`s0` `Running` through `s7` `Disposed; cleanup attempted`), typing, key chords, text clicks, coordinate clicks, wheel scrolling, incremental versus non-consuming reads (`O1`), text and idle waits (`O2`, `O3`), frame sampling, resize, write guards after exit (`S1`), single close notification (`S2`), real exit retention (`S3`), and post-exit cleanup (`S4`).
- `recording` drives [F08 through F11](features/recording-and-media.md) and exercises the `Recorder` completion and publication statechart (`s0` `Recording output` through `s10` `Saved process`), interval stop (`s1` to `s9`, `C4`), process completion (`s2` to `s10`, `C1`, `C3`), existing-target conflict (`s4` and `s5` to `s3`, `NoClobber`), control-slot reservation (`C2`), Retina PNG screenshots (`F10`, `W3`), and offline MP4 export (`F09`, `W1`, `W2`).
- `protocols` drives [F12 through F14](features/attach-and-boundaries.md) and checks local help, version, and `logfile` dispatch (`F14`), HTTP and WebSocket request admission against browser `Origin`, invalid `Host`, and cross-site `Sec-Fetch-Site` headers (`F13`, `A3`), and WebSocket `/attach` protocol 2 negotiation, output replay, framed input, resize, detach without kill (`A1`), and subscription release on socket close (`A2`).
- `models` checks the feature-map inventory (`scripts/check-feature-map.mjs`), runs TLC across [Relay.tla](../../../docs/feature-map/models/Relay.tla), [Session.tla](../../../docs/feature-map/models/Session.tla), and [Recorder.tla](../../../docs/feature-map/models/Recorder.tla), verifies the statechart state and step counts (`Relay` 22 states and 49 steps, `Session` 12 states and 26 steps, `Recorder` 64 states and 114 steps), and runs the three negative-control mutations (`CompatibleNotKilled`, `NoClobber`, and `CleanupRequiresExit`) via `scripts/check-statechart-controls.mjs`.

When invoking `bun src/cli.ts` directly during manual reproduction, always pass `launch '<command>'` instead of `-- <command>` because Bun strips `--` from `process.argv`. Use `tuistory -- <command>` only with the compiled binary.

## Evidence

Every `drive` run writes a self-contained receipt directory at `tmp/verification/verify-<timestamp>/` (or the directory passed to `--out`) and prints its absolute `evidenceDir` path in the JSON summary.

Proof standards for every run:

- Exercise the real CLI, library entry points, WebSocket attach endpoint, and TLC models rather than internal state setters.
- Record both the action and the resulting state in `evidence.json`, paired with raw artifacts under `artifacts/` (command transcripts, `sessions --json` snapshots, parsed `.cast` files, PNG headers and dimensions, `ffprobe` media streams, HTTP admission responses, WebSocket frames, and TLC logs).
- Verify side effects from a second read-only view, such as parsing the written asciicast v3 file on disk, decoding PNG dimensions from the output file, probing the MP4 container with `ffprobe`, and reading kernel TCP listeners after `daemon-stop`.
- Keep runtime observations distinct from bounded model checks. Each check entry in `evidence.json` labels its `kind` (`cli`, `library`, `protocol`, or `model`), `featureIds`, `statechartStates`, `properties`, `actionArtifact`, `observationArtifact`, and `assertion`.

## Cleanup

`drive` runs cleanup automatically in its `finally` block. You can also run cleanup directly after an interrupted manual command:

```bash
bun .agents/skills/verify/scripts/verify.ts cleanup --port 19953 --out tmp/verification/verify-latest
```

Cleanup stops only the relay daemon listening on the verification port, removes temporary runtime directories created for the child processes, verifies that the verification port returns to `no-listener`, and checks that `evidence.json` and `artifacts/` still exist on disk. It refuses ports `19977`, `19951`, and `19952` and never kills processes by name.

## Helpers

[verify.ts](scripts/verify.ts) is executable and takes four subcommands:

```bash
bun .agents/skills/verify/scripts/verify.ts doctor [--port 19953]
bun .agents/skills/verify/scripts/verify.ts drive [--feature all|lifecycle|terminal|recording|protocols|models] [--port 19953] [--out <dir>]
bun .agents/skills/verify/scripts/verify.ts cleanup [--port 19953] [--out <dir>]
bun .agents/skills/verify/scripts/verify.ts validate-skill
```

Run `validate-skill` after editing this skill or its feature map to verify frontmatter fields, required sections, the four-H2 feature contract, and all relative file links. Use `/maintain-verification-skill` when CLI commands, public `Session` members, or statechart transitions change.
