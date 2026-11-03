# Escalation

TLC reached 28 states and 54 steps. The chart draws 22 states and 32 arrows.
The chart does not draw 18 steps that stay in one chart state.

## TargetDoesNotExpand breaks
The shortest path has 6 steps:
0. old daemon; before TERM
1. send TERM to old daemon: old daemon; waiting for exit
2. old daemon exits: free port; waiting for exit
3. pending successor binds: healthy successor; waiting for exit
4. grace interval ends: healthy successor; look up escalation target
5. enumerate listener: healthy successor; selected successor
6. apply escalation policy: Successor was killed

## Rules that hold
NoDeadlock
