# Lifecycle requirements and implementation checks

This experiment separates required behavior from the mechanism used to provide it. It found two runtime bugs beyond the ticket mutex, reproduced them on real processes, and added focused repairs. The baseline is commit `2e031b8b8796d2bf734fd91a80500b31eba2e416`.

## Contracts before mechanisms

The first contract protects requesting clients. Starting a daemon may make the service available and complete requests; it must not terminate another caller. [LifecycleContract.tla](LifecycleContract.tla) states that small requirement without locks, ports, files, or PID discovery. Its environment excludes independent client crashes and concurrent explicit stop requests.

The second contract concerns one replacement operation already authorized to retire an old daemon. That operation may remove the old instance, but must leave an unrelated successor and its sessions alone. [ReplacementContract.tla](ReplacementContract.tla) describes instance lifetime and sessions without signal escalation or listener discovery. It excludes a separately authorized stop or independent crash of the successor.

These are scoped contracts, not a complete specification of every lifecycle command. They describe two user-visible harms independently of the code paths that caused them.

[ProbeInterleaving.tla](ProbeInterleaving.tla) maps concrete client states to the first contract. A temporary port bind is an internal step: it must not change caller survival or service availability. [Escalation.tla](Escalation.tla) maps listener selection and signals to the second contract. TLC checks `RefinesLifecycle` and `RefinesReplacement`, which instantiate the respective abstract `Spec` with those mappings. This is a finite behavioral refinement check, not a proof about arbitrary TypeScript executions.

The [coordination comparison](coordination-results.md) separately checks the former expiry lock, the current ticket lock, and an ideal operating-system lock against shared ownership invariants. Those invariants do not imply the two lifecycle contracts. A correct mutex can surround an incorrect operation.

## Findings and repairs

| Finding | Counterexample | Real-code result before repair | Repair |
| --- | --- | --- | --- |
| L01: a probe becomes a victim | A binds the relay port to test availability and pauses. B locks, observes the occupied port, and signals A. | Under Bun and Node, A received SIGTERM; exit codes were `[null, 0]` instead of `[0, 0]`. | The unlocked fast path only requests `/version`. All bind probes run under the existing lifecycle lock. |
| L02: escalation changes victims | The old daemon receives TERM. A different daemon binds before escalation discovery. The original operation selects it for KILL. | A real CLI-created pending child became a compatible daemon with a session, then received SIGKILL. Regressions also reproduced the loss during `daemon-stop`. | Retain the initial target PID set. A later foreign listener causes failure before any escalation signal. |

The three new tests in [relay-lifecycle.test.ts](../../../src/relay-lifecycle.test.ts) fail against the baseline and pass with the repairs under both runtimes. They pause actual processes at observable scheduling boundaries. They do not replace listener output, signal results, or daemon HTTP responses. The escalation tests preserve the successor's process and session and require a nonzero result from the interrupted replacement operation.

The production repair retains `killRelay(): Promise<boolean>` and the existing lifecycle lock. It adds no dependency, public option, retry framework, or daemon protocol. Three independent design candidates converged on this shape. A broader generation/admission protocol was rejected for these two fixes because it adds persistent ownership state and cross-version behavior.

## Results within the model bounds

| Implementation variant | Result |
| --- | --- |
| Baseline out-of-lock probe, `ProbeCurrent.cfg` | `CallersSurvive` fails in a ten-state trace. |
| Lock-scoped probe, `ProbeSerialized.cfg` | 37 reachable states; invariant and lifecycle refinement pass. |
| Baseline unrestricted escalation | `TargetDoesNotExpand` fails. |
| Fixed-target escalation | 29 reachable states; invariant and replacement refinement pass. |
| Current ticket mutex | 651 reachable states; both shared ownership invariants pass. |
| Ideal OS mutex candidate | 27 reachable states under an assumed kernel-lock contract; no portable implementation was built. |

The runner checks 17 expected outcomes, including the old expiry failure, mutated ticket logic, weak directory visibility, property-only refinement failures, and progress checks without fairness. A failure only counts as an expected counterexample when both the TLC exit code and the intended diagnostic match. Syntax errors, timeouts, and unrelated failures fail the runner.

The property-only controls remove the redundant local invariants from the broken lifecycle configurations. The abstract contracts still reject the bad transitions. This checks the refinement connection rather than relying only on implementation-local assertions.

The final full test runs passed 193 tests under Bun with 55 skipped, and 127 under Node with 56 skipped. Independent review reran all 17 model cases, the source-copy controls, the lifecycle regressions, and same-listener escalation under both runtimes.

## Model-to-code correspondence

| Model action | Code boundary | Abstraction |
| --- | --- | --- |
| Probe ReadVersion, Recheck | [getRelayVersion](../../../src/cli.ts#L1649) and [ensureRelayRunning](../../../src/cli.ts#L2225) | One returned HTTP observation. |
| Probe Acquire | `withRelayLifecycleLock` in ensure | Ideal exclusive acquisition; the separate ticket model checks its implementation assumptions. |
| Probe Bind, Busy, CloseProbe | [isPortInUse](../../../src/cli.ts#L1794) | Bind and close are separate transitions; a paused binder can remain visible. |
| Probe Discover, Signal | [killRelay](../../../src/cli.ts#L1737) | Capture the listener, then signal that captured identity in a separate transition. |
| Probe Spawn, Complete | [spawnRelayServer](../../../src/cli.ts#L2176) and readiness return in ensure | Spawn/readiness are collapsed; completion means ensure finished, not that the later forwarded command succeeded. |
| Escalation SendTerm, WaitEnds, Discover, SendKill | `killRelay` | Separate initial signal, end of grace interval, fresh enumeration, and escalation signal. |
| Escalation OldExit, SuccessorBinds, LaunchSession | Daemon processes and `/cli` | Environment events independent of the client's lock. |

The baseline probe configuration retains the former out-of-lock call. The repaired source corresponds to `ProbeSerialized.cfg` and `EscalationFixed.cfg`. The diagrams check local safety invariants; the main runner separately checks the full refinement properties.

## Statecharts

| Case | Before repair | After repair |
| --- | --- | --- |
| Probe ownership | [White-background diagram](charts/probe-before.svg), [trace](charts/probe-before.report.md), [source](charts/probe-before.mmd) | [Diagram](charts/probe-after.svg), [report](charts/probe-after.report.md), [source](charts/probe-after.mmd) |
| Escalation targets | [White-background diagram](charts/escalation-before.svg), [trace](charts/escalation-before.report.md), [source](charts/escalation-before.mmd) | [Diagram](charts/escalation-after.svg), [report](charts/escalation-after.report.md), [source](charts/escalation-after.mmd) |

For these diagrams, copy the models and configs to a scratch directory, remove `PROPERTY` lines from the scratch chart configs, and run `/statechart` with [Probe.view.mjs](Probe.view.mjs) or [Escalation.view.mjs](Escalation.view.mjs). Keep the original configs unchanged. The complete checker still requires refinement and progress properties. The chart reports count exploration beyond the first safety violation, so their state counts differ from the runner's failing runs. Each report states how many transitions stay inside one displayed label; those internal transitions are hidden in the diagram.

## Run the checks

Use Java 21 and the pinned tools distribution. The jar reports TLC 2.19, revision `5a47802`; the distribution tag is `v1.7.4`. Its SHA-256 is checked by the script.

```sh
mkdir -p /tmp/tuistory-tlc
curl -fL -o /tmp/tuistory-tlc/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
export TLA2TOOLS=/tmp/tuistory-tlc/tla2tools.jar
export JAVA=java
bun scripts/check-lifecycle-models.mjs
bun docs/verification/lifecycle/replay-coordination.mjs
bun test src/relay-lifecycle.test.ts
bun run test:node src/relay-lifecycle.test.ts
```

The TLC command writes raw output, generated controls, counts, and exact Java arguments to a fresh temporary directory. It runs each case with one worker and a 55-second timeout. The source-derived replay uses two Bun processes, retains evidence outside the repository, and removes no production source. It needs the legacy baseline commit in local Git history.

The lifecycle tests own port 19952 and handle cleanup. Do not run their Bun and Node variants concurrently. The new process-suspension regression runs on POSIX; the escalation scheduling fixture uses macOS system lsof and skips other platforms. The production policy itself is shared across platforms.

For visual counterexamples, use Pstack `/statechart` with the source models and view modules here, then render with Pele as described in the [existing chart guide](../../feature-map/statecharts.md). The model checker and source-replay commands do not depend on Pstack.

## Boundaries and assumptions

The probe model has two clients, one start request each, an ideal exclusive lifecycle lock, and one abstract compatible daemon. It separates HTTP observation, bind acquisition, bind release, lock acquisition, selection, and signaling. Spawn and service readiness are one abstract step in this slice. Pending children, client crashes, explicit stops, version differences, and timeout outcomes are outside this model.

The escalation model starts after the initial target has been selected. It has one replacement operation, an old daemon, and one unrelated successor. Old exit, successor bind, session creation, enumeration, and signal delivery are separate steps. Its instance identities stand for different PIDs without reuse. An initial TERM can remain pending while the old process is stopped. The model does not bind the earlier health response to this selected target.

The lock comparison has two callers and one attempt each. Its [mapping and assumptions](coordination-results.md) separate directory enumeration from ticket reads and PID probes. It assumes coherent local directory visibility, atomic rename, successful filesystem operations, and no PID reuse. Conditional completion requires fairness and eventual callback return or caller death; it is not a starvation-freedom or wall-clock deadline guarantee.

## Open limits

A failed health observation and a later signal are not atomic. A real replay confirmed that the same daemon can recover and serve its sessions before the replacement signals it. The runtime currently proceeds following the failed under-lock observation. A stronger requirement that every daemon healthy at signal time survives remains unsatisfied. This experiment records that gap rather than weakening the stronger requirement and declaring it verified.

A different listener can also appear between the health observation and the first listener discovery. Fixed escalation targets do not solve that initial-selection window. Numeric PID reuse and discovery-to-signal races remain. These need stronger process identity or cooperative generation mechanisms to establish stronger guarantees.

An abandoned detached child can still bind after its parent dies or after a free-port observation. Preventing all such resurrection would require startup admission or cancellation across processes. Old binaries do not participate in the new lifecycle mutex. The experiment did not implement that broader protocol or claim those requirements pass.

Model passes cover the stated finite scopes. The real replays connect specific modeled schedules to code; they do not mechanically prove that every code execution is represented. Recheck that correspondence when source operations or atomic boundaries change.
