# Relay and named-session lifecycle

## F01. Relay lifecycle

Ordinary commands call `ensureRelayRunning()`. Its unlocked fast path only requests the version over HTTP. Under the lifecycle lock, `probeRelay()` returns `healthy(version)`, `no-listener`, or `occupied-unresponsive`. The port is authoritative when HTTP does not answer. A compatible healthy version observed by either check is reused. [Probe](../../src/cli.ts#L1717), [startup flow](../../src/cli.ts#L2225).

| Event | Guard | State change and observable result |
| --- | --- | --- |
| Probe compatible daemon | Healthy version at least the client version | Return without restart; existing sessions survive |
| Lock is busy | Another live contender has priority | Wait up to 15 seconds for ownership; recheck contenders so a dead owner does not strand waiters |
| Acquire lock wins | Published ticket has priority and no live contender is still choosing | Re-probe before any destructive action; timeout never evicts a live owner |
| Re-probe compatible | Another client already repaired the daemon | Release lock and reuse |
| Replace listener | Older healthy or occupied-unresponsive listener | Signal only the initial IPv4 listener targets; reject foreign PIDs during escalation; spawn only after a successful free-port result |
| Start replacement | No listener, or kill freed the port | Spawn detached with pinned port and stable cwd; wait up to five seconds and terminate this spawn on ordinary startup timeout |
| Bind loses | `EADDRINUSE` | Daemon exits zero without writing a PID file |
| Shutdown | First SIGINT or SIGTERM | Reject new CLI work, close sessions, wait for pending work or deadline, clear map, remove owned PID, close server |
| `daemon-stop` | Any occupied port state | Take the same lifecycle lock, probe, stop listener and require free port |

Source ownership is split across [killRelay](../../src/cli.ts#L1737), [lifecycle lock](../../src/relay-lock.ts), [listener discovery](../../src/relay-listener.ts), [bind handlers](../../src/cli.ts#L2075), [shutdown](../../src/cli.ts#L2100), and [daemon spawn](../../src/cli.ts#L2176).

Candidate properties for later implementation verification are as follows.

| ID | Property | Boundary and uncertainty |
| --- | --- | --- |
| R1 | A client that observes a compatible healthy daemon does not intentionally kill it | Probe results can become stale; the starter model excludes concurrent replacement |
| R2 | Spawn follows no listener or successful port release | An external process may bind between observation and spawn; bind-loss handling remains necessary |
| R3 | Only a successfully bound daemon writes its PID; removal checks ownership | PID files are diagnostic and never signal authority. Port enumeration followed by numeric signaling still has an OS process-identity race |
| R4 | At most one client performs replacement at a time | Unique contender directories and ticket ordering assume a coherent local filesystem. Only ESRCH permits dead-record cleanup; PID reuse can conservatively block progress. Older binaries do not use this protocol |

Tests cover [shutdown during preparation](../../src/cli.test.ts#L551), [shutdown during restart](../../src/cli.test.ts#L598), [ordinary stop](../../src/cli.test.ts#L639), [missing PID](../../src/cli.test.ts#L665), [bind loss](../../src/cli.test.ts#L695), and [unresponsive listener replacement](../../src/cli.test.ts#L731). [Lifecycle regressions](../../src/relay-lifecycle.test.ts) add real interrupted contenders, crash recovery, stop/start ordering, malformed version responses and an unrelated process named by a stale PID file. The original ten-second expiry bug was reproduced before repair; these tests are not an exhaustive interleaving proof.

The [concurrent lifecycle experiment](../verification/lifecycle/README.md) adds paused port-probe survival and successor preservation during escalation. Both were reproduced before repair and checked under Bun and Node. It separates ownership invariants from user-level refinement and records the remaining health-observation and pending-child gaps.

## F02. Named sessions

The daemon owns `Map<string, Session>` and `pendingSessions`. A pending entry is either `launch(intent, promise)` or `lifecycle(close | restart, done)`. A lifecycle reservation releases only if it is still the exact entry stored under that name. [Reservation type and release](../../src/cli.ts#L242).

| Event | Existing state | Behavior |
| --- | --- | --- |
| Launch | No live session and no reservation | Reserve name, prepare recording if requested, create session, then publish it |
| Duplicate launch | Pending launch with identical serialized intent | Join the creation promise |
| Conflicting operation | Pending launch with different intent, or pending close/restart | Reject rather than replace the reservation |
| Launch | Live session under the name | Reuse it even if command or cwd differs; recording adds a compatibility check |
| Process exits | Published session | Retain the object and output for inspection |
| Launch | Dead session | Replace it; old dead sessions may be evicted opportunistically after one day |
| Close | Published session, no conflicting reservation | Reserve, await close, delete only if the same object remains, release |
| Restart | Published session, no conflicting reservation | Preserve command, cwd, geometry, environment and session ID; stop/close old process; create replacement |
| Shutdown during preparation | Creation has not yet spawned | `canStart()` rejects creation after preparation |

[Launch](../../src/cli.ts#L322), [duplicate and reuse decisions](../../src/cli.ts#L350), [creation guard](../../src/session.ts#L56), [close](../../src/cli.ts#L1350), [restart](../../src/cli.ts#L1416).

Restarting a recorded session chooses a new randomized filename. Restart preserves `TUISTORY_SESSION_ID`; a fresh launch creates a new identity. Generated names include a cwd hash. Nested launch under `TRAFORO_URL`, `SIGILLO`, or `TUISTORY_SESSION` executes a direct child; nested recording is rejected. Human TTY launches auto-attach unless background operation is requested. [Recording filename](../../src/cli.ts#L201), [nested dispatch](../../src/cli.ts#L2474), [auto-attach](../../src/cli.ts#L2584).

| ID | Candidate property | Existing evidence and remaining work |
| --- | --- | --- |
| N1 | One name has one pending lifecycle owner; identical launch requests share creation | Source reservations; concurrent identical/conflicting launch matrix not identified |
| N2 | Close or restart cannot delete a newer object under the same name | Identity checks in [close](../../src/cli.ts#L1386) and [restart](../../src/cli.ts#L1457); model object identity across awaits |
| N3 | Shutdown prevents new child creation after async preparation | [Delayed preparation regression](../../src/cli.test.ts#L551); include restart and shutdown in the same future model |

Observable journeys include [caller cwd](../../src/cli.test.ts#L207), [environment forwarding](../../src/cli.test.ts#L478), [live-name reuse](../../src/cli.test.ts#L379), [command restart](../../src/cli.test.ts#L1125), [cwd preservation](../../src/cli.test.ts#L1158), [identity preservation](../../src/cli.test.ts#L1183), and [dead-session restart](../../src/cli.test.ts#L1212). A successful silent-but-live launch can include a warning. A silent process that already exited fails launch. A joined duplicate request does not repeat the original caller's readiness wait.

The lock serializes live cooperating lifecycle operations. A detached child spawned immediately before its parent crashes can bind later; this repair does not add cancellation of abandoned pending starts. Listener discovery targets IPv4 loopback or wildcard TCP listeners. Windows signals do not guarantee POSIX-style graceful cleanup.
