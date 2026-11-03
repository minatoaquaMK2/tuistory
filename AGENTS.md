this project uses bun to install and test

this package is supposed to run both in node and bun. to test node.js features we use test:node to run the test in node.js too

## running cli locally

use `bun src/cli.ts` instead of tuistory to run the cli locally for testing.

**ALWAYS stop the daemon before manually testing any code change.** the relay daemon is a long-lived background process that keeps the **old compiled code** in memory across CLI invocations. so `bun src/cli.ts launch ...` will silently exercise the previous version of your code, and changes to middleware, route handlers, session logic, CLI flags, parsing, or anything else in the daemon process will appear to be ignored.

run this before every local smoke test:

```bash
bun src/cli.ts daemon-stop
# also stop the test daemon if you've been running the test suite
TUISTORY_PORT=19951 bun src/cli.ts daemon-stop
```

the next `bun src/cli.ts <command>` will spawn a fresh daemon with your updated code.

the test suite already handles this automatically: `src/cli.test.ts` uses port `19951` (separate from the default `19977` so it never touches user sessions) and `killTestDaemon()` runs in `beforeAll` / `afterAll`. that function kills the recorded PID, also kills anything still bound to port `19951` (covers orphans whose PID file was lost), and waits for the port to be free before tests start. you do **not** need to manually stop daemons before running `bun test`; just remember to stop them before manual `bun src/cli.ts ...` invocations.

## relay daemon lifecycle

the CLI is a thin client. all sessions live in a long-lived **relay daemon** (an HTTP + WebSocket server on `127.0.0.1:19977`, override with `TUISTORY_PORT`). the daemon is spawned detached with `stdio: 'ignore'` and the argv marker `__tuistory-relay-daemon`. never use an env var for relay mode: PTY sessions inherit the daemon env, so nested `tuistory` calls would become daemons. every CLI invocation first runs `ensureRelayRunning()` before forwarding the command to the daemon over `POST /cli`.

**the port is the source of truth, not the `/version` HTTP probe.** a daemon can hold the port while being unable to answer HTTP (wedged event loop, mid-startup, or an orphan whose parent died and left it on `PPID 1`). trusting `/version` alone made the client think "no daemon" and spawn a second one that crashed on bind with `EADDRINUSE`. so `probeRelay()` classifies the port into exactly three states:

```
probeRelay()
   │
   ├─ GET /version answers ─────────────────────► healthy(version)
   ├─ /version silent && port is bindable ──────► no-listener
   └─ /version silent && port is occupied ──────► occupied-unresponsive
```

### ensureRelayRunning flow

every replacement runs under `withRelayLifecycleLock()` from `src/relay-lock.ts`. `daemon-stop` takes the same lock. Each caller creates a unique PID-and-random-token directory under `/tmp/tuistory/lifecycle-PORT`, publishes a ticket atomically, then scans again before entering. A live owner never expires. Only an `ESRCH` liveness result permits cleanup of another caller's unique directory. Permission errors and PID reuse can cause a safe timeout. The shared parent stays in place; the lock assumes a coherent local filesystem.

```
ensureRelayRunning()
   │
   ├─ probeRelay(): healthy && version >= ours? ──► reuse, return
   ▼
   withRelayLifecycleLock()  (wait up to 15 seconds)
   │   ├─ timeout ──► fail without stealing a live owner's lock
   │   └─ acquired
   │       ├─ re-probe healthy && version >= ours? ──► reuse
   │       ├─ occupied? ──► killRelay(); require free port
   │       ├─ spawnRelayServer() with pinned TUISTORY_PORT
   │       └─ waitForRelay(5s)
   │           ├─ ready ──► return
   │           └─ timeout ──► terminate own spawned child, then fail
   └─ finally remove only this caller's unique contender directory
```

A waiting client can acquire after the previous owner dies, even if no daemon was started. Legacy `restart-PORT.lock` files are no longer used. Old binaries do not participate in the new mutex; healthy older clients still reuse a newer daemon. An abruptly killed starter can leave a detached child that has not bound yet, so the lock alone does not cancel abandoned pending starts.

key rule: **a healthy daemon at an equal-or-newer version is never killed.** killing the daemon destroys all in-memory PTY sessions, so a version match (or newer) always reuses the running daemon.

The implemented reuse decision is based on an HTTP observation. The unlocked fast path calls only `getRelayVersion()`; every bind-based occupancy probe runs under the lifecycle lock. A daemon can recover after a failed health observation but before signaling, so the stronger instantaneous-health rule above is not established. See `docs/verification/lifecycle/README.md` for the reproduced gap and finite verification scope.

### version mismatch / update case

when you publish a new version and run any command with the updated CLI while an OLD daemon is still running:

1. `probeRelay()` returns `healthy(oldVersion)`. `isUsableVersion(oldVersion)` is `oldVersion >= ourVersion`, which is false, so the fast path is skipped.
2. the client takes the restart lock, logs `Relay server version mismatch (server: X, client: Y), restarting...`.
3. `killRelay()` discovers the current TCP listener by port and sends SIGTERM. The daemon runs `gracefulShutdown()`: **closes every session, kills their child process groups, unlinks its PID file**. It waits for the port to be free and re-resolves the listener before SIGKILL escalation. PID-file contents never authorize a signal. Listener discovery filters the IPv4 loopback or wildcard TCP endpoint. macOS uses system lsof, Linux uses procfs, and Windows uses system netstat. Windows signals do not provide POSIX graceful-shutdown parity.
4. `spawnRelayServer()` starts a fresh daemon on the same port; it writes the PID file only on `listening`.
5. `waitForRelay(5s, ourVersion)` confirms the new daemon answers with the new version, then the command is forwarded.

**updating the daemon wipes running sessions.** this is intentional and unavoidable: sessions live in the old process's memory, and running new code requires killing it. after an update `tuistory sessions` is empty and you relaunch.

direction matters: **old daemon + new CLI ⇒ restart** (new wins); **new daemon + old CLI ⇒ reuse** the newer daemon as-is (never downgrade).

### daemon-stop

`runDaemonStopCommand()` acquires the same lifecycle lock before probing. It also treats the port as truth: it signals the IPv4 listener covering the relay address (via `killRelay()`), and prints `No daemon running` only when `probeRelay()` returns `no-listener`. if the port can't be freed it exits non-zero instead of falsely reporting success.

`killRelay()` fixes its allowed PID set at the first listener discovery. Before SIGKILL, it discovers listeners again and refuses if any PID is outside that initial set. A successor occupying the port causes a safe error for both ensure and stop. Numeric PID reuse and the initial health-to-listener observation window remain outside this protection.

### startup is bind-safe

`startRelayServer()` builds the server with `createAdaptorServer()` and attaches `error` / `listening` handlers **before** calling `listen()`. `@hono/node-server`'s `serve()` helper binds with no error handler, so a lost bind race used to surface as an unhandled `'error'` event and crash with a confusing `EADDRINUSE` stack. now a daemon that loses the race exits cleanly (code 0); any other listen error exits 1. the PID file is written only after a successful bind and removed only by its owner, so a failed-to-bind daemon never writes the real listener's PID file. The file is diagnostic; reading then unlinking it is not an atomic ownership operation.

## prefer `--` over `launch`

always use `tuistory -- <command>` instead of `tuistory launch "<command>"`. the `--` form is shorter and avoids quoting issues with nested commands. `launch` is a hidden alias for the same thing but `--` is the canonical syntax.

```bash
# good
tuistory -s myapp -- pnpm dev
tuistory -s dev -- kimaki tunnel -- pnpm dev

# avoid
tuistory launch "pnpm dev" -s myapp
tuistory launch "kimaki tunnel -- pnpm dev" -s dev
```

**bun strips `--` from process.argv** ([bun#13984](https://github.com/oven-sh/bun/issues/13984)). when testing locally with `bun src/cli.ts`, use `launch` with a quoted string instead of `--`:

```bash
# local dev testing (bun strips --)
bun src/cli.ts launch 'echo hello world'

# NOT: bun src/cli.ts -- echo hello world
# bun eats -- and only "echo" reaches the CLI, "hello world" is lost
```

the installed `tuistory` binary does not have this issue because it runs as a shebang script.

## always use bun, never tsx

always use `bun` to run typescript files, never `tsx`. the cli daemon spawns using `process.execPath` so it uses the same runtime. using tsx can cause issues with wrong module resolution paths.
