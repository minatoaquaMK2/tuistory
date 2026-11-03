# Lifecycle coordination comparison

The common contract is deliberately small. At most one living caller may be inside the lifecycle callback. A living caller inside that callback retains its claim until the callback returns. These are subordinate coordination requirements. They do not establish correct daemon selection, safe signaling, preservation of sessions, or cancellation of detached children.

`CoordinationContract.tla` states those requirements independently of the algorithms. `LegacyLock.tla`, `TicketLock.tla`, and `OsLock.tla` map their implementation states to the same contract.

The current ticket algorithm passes this finite model. The former expiry lock fails. An ideal kernel lock also passes, but its pass assumes the kernel ownership and cleanup semantics that an implementation would need to establish.

## Reproduce

Run from the repository root:

```sh
bun scripts/check-lifecycle-models.mjs

bun docs/verification/lifecycle/replay-coordination.mjs
```

Set `JAVA` and `TLA2TOOLS` using the [setup instructions](README.md#run-the-checks). The tested jar reports `TLC2 Version 2.19 of 08 August 2024`, revision `5a47802`. Its SHA-256 is `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. The distribution tag is `v1.7.4`; that is not the TLC version printed by this binary.

The runner invokes Java with `-XX:+UseParallelGC -Xmx1g -cp "$TLA2TOOLS" tlc2.TLC -workers 1 -fp 0 -metadir UNIQUE_DIRECTORY -config CONFIG MODULE.tla`. It gives each run 55 seconds and saves raw logs, exact commands, and counts in a new temporary output directory. A negative control only passes the runner when TLC reports its specified violation. A syntax error or unexplained failure does not count.

Results recorded on 2026-11-03:

| Configuration | Result | Generated states | Distinct states |
| --- | --- | ---: | ---: |
| TicketLock | Both ownership requirements pass | 1,859 | 651 |
| TicketLockCompletion | Fair completion passes | 1,859 | 651 |
| LegacyLock | LiveOwnerKeepsClaim fails | 488 | 216 |
| LegacyLockOverlap | MutualExclusion fails | 868 | 369 |
| TicketLockNoPostScan | MutualExclusion fails | 598 | 252 |
| TicketLockSaturated | MutualExclusion fails | 1,152 | 384 |
| TicketLockWeakListing | MutualExclusion fails | 1,178 | 436 |
| OsLock | Both ownership requirements pass | 67 | 27 |
| OsLockCompletion | Fair completion passes | 67 | 27 |

Failing rows stop at the first shortest counterexample and do not count the full reachable graph. Passing safety graphs are exhaustive within the stated model. No symmetry reduction, view reduction, state constraint, or depth limit is used.

## Atomic boundaries and source mapping

The current mapping was checked at commit `2e031b8b8796d2bf734fd91a80500b31eba2e416`. The `src/relay-lock.ts` Git blob is `823da1e82d6c59be221180d49173d530dc13367e`.

| Model action | Current source | Meaning |
| --- | --- | --- |
| Register | `src/relay-lock.ts:65` | Create this caller's unique directory. |
| ChooseList, WaitList | `src/relay-lock.ts:17`, `:69`, `:79` | Enumerate names. Do not read tickets or PID state yet. |
| Probe | `src/relay-lock.ts:29` | Observe PID liveness. |
| RemoveDeadTicket, RemoveDeadDirectory | `src/relay-lock.ts:33` | Remove a dead contender's file, then its directory in a separate step. |
| ChooseRead, WaitRead | `src/relay-lock.ts:40`, `:72`, `:82` | Read an immutable published ticket and apply the local comparison. |
| ChooseStat, WaitStat | `src/relay-lock.ts:44` | Distinguish missing ticket from missing contender after the failed read. |
| WriteTemporary, Publish | `src/relay-lock.ts:74`, `:75` | Write the private temporary file, then publish through atomic rename. |
| Timeout | `src/relay-lock.ts:78` | Abort while waiting, then remove only this caller's directory. |
| Enter, Return | `src/relay-lock.ts:86` | Callback begins and later settles. |
| CleanupTicket, CleanupDirectory | `src/relay-lock.ts:90` | Remove this caller's file, then its directory separately. |

Reads of different files, enumeration, PID probing, publication, callback entry, and directory removal are separate model actions. A scan never captures a coherent snapshot of names, tickets, and liveness together. Local arithmetic and comparison may share the action that supplies their input because they add no shared observation. `ChooseStat` keeps its separate step even though both of its results leave the tentative number unchanged.

For two callers there is exactly one relevant directory entry per scan. The default enumeration premise is that a directory already present throughout enumeration is included. A concurrent registration may fall before or after that observation. The model therefore does not require a multi-entry snapshot. It does require the documented coherent local filesystem premise to include already-present records. `TicketLockWeakListing` deliberately permits omission of a continuously present record. Its failure demonstrates dependence on that premise; it is not evidence that the actual filesystem violates it.

Temporary and published files never coexist in one contender directory in this model. Rename changes their names atomically. Cleanup's file-removal action removes whichever one exists; directory removal remains a separate action. No operation that deletes two existing files is treated as atomic.

The legacy mapping uses `2bc5b367bda0ab0da8009e0141d2345317c8f78e:src/cli.ts:1792-1827`. `Open` models exclusive creation separately from `WritePayload`. An open descriptor can still write its inode after the pathname was unlinked. `Read`, `CheckStale`, `UnlinkStale`, and the retry `Open` are separate. Release's PID read and unlink are also separate. Expiry is an independent clock step, even while a live caller is paused inside its callback.

## Counterexamples and real replays

In `LegacyLockOverlap`, the shortest failure has 12 states:

1. Initial state.
2. A exclusively opens the lock file.
3. A writes its PID and timestamp.
4. A enters its callback.
5. The timestamp expires while A remains alive.
6. B's exclusive create fails.
7. B reads A's PID and expired timestamp.
8. B decides the lock is stale.
9. B unlinks A's lock. `LiveOwnerKeepsClaim` already fails here.
10. B's exclusive retry opens a replacement lock.
11. B writes its own PID and timestamp.
12. B enters while A is still inside. `MutualExclusion` fails.

`replay-coordination.mjs` extracts the actual legacy functions from Git and runs them in two Bun processes. It leaves A alive inside its callback and ages the existing lock timestamp by 10,001 milliseconds. This is a controlled clock-state injection, not a ten-second wall-clock test. B then acquires and both callback markers coexist. The wrapper supplies the scratch lock path and replaces only directory creation with a no-op because that directory already exists. The acquisition, stale check, takeover, and release bodies are unchanged.

`TicketLockNoPostScan` reaches overlap in 13 states. A publishes ticket 1 and enters. B observes A, chooses ticket 2, publishes it, skips the waiting scan, and enters. The replay creates a scratch copy of the current module and replaces only the post-publication `blocked` calculation with `false`. Two real processes overlap. The unmodified source is also replayed with A held in its callback: B times out and never enters. Production source remains byte-for-byte unchanged. The runner waits for every worker to exit and force-terminates any worker that cannot finish cleanup.

`TicketLockSaturated` reaches overlap in 17 states. Actor 2 publishes ticket 1 and completes its entry scan before actor 1 registers. Actor 1 sees that ticket, but the mutation prevents the required increment. It also publishes 1. Its lower ID wins the tie, so both callers can enter. This is an abstract non-increasing arithmetic control, not a counterexample to the actual `BigInt` code. It explains why strictly increasing ticket selection matters. It is model-only; no numeric-overflow claim is made about the current code.

`TicketLockWeakListing` reaches overlap in 13 states. A publishes and enters. B's initial and final scans both omit A, so B also chooses 1 and enters. This is an assumption sensitivity check only. The current source-derived replay uses the real local filesystem and does not inject stale directory listings.

## Bounds and excluded behavior

Each model has two real caller identities and one lock attempt per caller. Ticket values 1 and 2 arise naturally within that bound; there is no truncation of the normal algorithm. Unique directory tokens do not collide or get reused. Callers may crash before or after each modeled step. A crash permanently ends that identity's execution. A paused caller simply receives no scheduler steps and can resume later. Safety checks impose no fairness assumption and therefore permit arbitrary pause duration.

The baseline filesystem accepts operations and publishes immutable ticket contents through atomic rename. Ticket parsing failures, partial payload writes, I/O errors, external modification of contender files, network filesystems, PID reuse, and permission ambiguity are outside this finite model. Treating an ambiguous liveness result as alive preserves the intended conservative behavior but can prevent progress. The model's cleanup branch assumes a dead PID is eventually classified as dead, and never classifies a live one as dead.

The optional completion checks add weak fairness for each caller's modeled steps. This includes eventual callback return or caller crash. They check that both attempts eventually finish or crash; they do not promise acquisition, a 15-second wall-clock bound, starvation freedom under unbounded arrivals, or termination of an arbitrary user callback. Timeouts are an abstract permitted abort at a waiting-loop boundary. Real clock jumps and timeout scheduling are not modeled.

The safety models disable TLC's terminal-state deadlock warning because completed and crashed callers legitimately have no remaining transition. The separate completion checks supply the conditional progress claim.

## What the simpler candidate assumes

`OsLock.tla` delegates exclusive acquisition and crash cleanup to a kernel-owned lock object. Both callers must refer to the same stable object. Nobody may unlink and recreate its pathname while an old descriptor can still hold a lock. The selected primitive must conflict between the actual caller identities, and process exit must release ownership. Inherited descriptors must not prolong ownership after the intended owner dies. Cancellation and timeout must release acquired handles reliably.

Those are candidate implementation obligations. The model imports no runtime dependency and proves nothing about a particular Node, Bun, POSIX, or Windows locking binding. Its smaller state graph reflects an assumed atomic kernel contract. It does not mean a portable implementation has been demonstrated or that daemon lifecycle correctness follows from changing the mutex.
