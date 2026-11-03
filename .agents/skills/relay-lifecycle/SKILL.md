---
name: relay-lifecycle
description: Check relay lifecycle changes against bounded TLA+ contracts and real concurrency regressions. Use when changing relay locking, probing, listener selection, signaling, or daemon startup.
---

# Relay lifecycle verification

Read `docs/verification/lifecycle/README.md` for the independent requirements, model bounds, pinned TLC setup, and open limits. Read `coordination-results.md` beside it when changing the ticket mutex.

Coverage was grounded at commit `2e031b8b8796d2bf734fd91a80500b31eba2e416`. The current verification adds the HTTP-only unlocked fast path and fixed escalation targets described in the README. Before treating an inherited result as current, compare covered code with that baseline and the documented repair. Advance the sync commit only after reviewing correspondence at the new commit.

Covered code:

- `src/relay-lock.ts`: directory registration, liveness observation, ticket publication, scan, callback ownership, and cleanup.
- `src/cli.ts`: `probeRelay`, `isPortInUse`, `killRelay`, and `ensureRelayRunning`.
- `src/relay-listener.ts`: the PID/address discovery boundary, whose OS correctness is assumed by the lifecycle models and tested separately.
- `src/relay-lifecycle.test.ts`: paused probe survival and successor preservation during ensure and stop.

Run from the repo root after setting `JAVA` and `TLA2TOOLS` as documented:

```sh
bun scripts/check-lifecycle-models.mjs
bun docs/verification/lifecycle/replay-coordination.mjs
bun test src/relay-lifecycle.test.ts
bun run test:node src/relay-lifecycle.test.ts
```

Run the two runtime suites sequentially. They own port 19952. Follow root AGENTS.md for manual daemon testing. Keep scratch source mutations outside the checkout.

Read each TLA+ result with Pstack `/statechart`. Use its installed instructions rather than copying version-specific commands into this skill. Reproduce a model counterexample against real code before classifying it as a product bug. The existing views use user-visible labels; render images with Pele on white backgrounds.

The source replay extracts the old lock from Git, confirms its overlap, checks current timeout ownership, and makes a scratch-only current mutant skip the post-publication scan. That mutant must overlap. The model runner also requires deliberate property failures. A parser error or timeout is never a passing negative control.

If the source changes without corresponding model changes, report the affected result as stale. If intended behavior changes, update the independent requirement first, explain the changed promise, then update the implementation model and regression. Do not weaken a contract merely to remove a counterexample. Models that share ownership invariants are not automatically proven to refine the user-level lifecycle contracts.

Report bounds and assumptions with every pass. In particular, two-client models do not establish arbitrary-client correctness; ideal OS locking is a candidate contract, not a tested platform binding; numeric PID sets are not stable process handles; and the first health/identity window plus abandoned child admission remain outside the repaired guarantees. Use Pstack `/maintain-formal-verification-skill` when covered code changes without a corresponding verification update.
