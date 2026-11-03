# ProbeInterleaving

TLC reached 88 states and 141 steps. The chart draws 19 states and 37 arrows.
The chart does not draw 49 steps that stay in one chart state.

## CallersSurvive breaks
The shortest path has 9 steps:
0. Both callers check readiness
1. continue request: One caller finished its readiness check
2. continue request: Both callers finished their readiness checks
3. bind probe socket: Caller holds probe socket; peer: probe without lock
4. continue request: Caller holds probe socket; peer: wait for lock
5. acquire lifecycle lock: Caller holds probe socket; peer: recheck readiness
6. continue request: Caller holds probe socket; peer: probe with lock
7. continue request: Caller holds probe socket; peer: look up occupied port
8. continue request: Caller holds probe socket; peer: signal selected caller
9. signal the probe owner: A caller was killed

## Rules that hold
TypeOK, NoDeadlock
