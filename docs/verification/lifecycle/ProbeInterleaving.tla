-------------------------- MODULE ProbeInterleaving --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT SerializeProbe
Clients == {1, 2}
VARIABLES pc, port, lock, alive, completed, selected
vars == <<pc, port, lock, alive, completed, selected>>
Contract == INSTANCE LifecycleContract WITH
    Clients <- Clients, callers <- alive, available <- (port = 3), completed <- completed

Init == /\ pc = [c \in Clients |-> "http"]
        /\ port = 0 /\ lock = 0 /\ alive = Clients /\ completed = {}
        /\ selected = [c \in Clients |-> 0]

ReadVersion(c) == /\ pc[c] = "http"
                  /\ pc' = [pc EXCEPT ![c] = IF port = 3 THEN "complete"
                                             ELSE IF SerializeProbe THEN "lock" ELSE "probeOutside"]
                  /\ UNCHANGED <<port, lock, alive, completed, selected>>
Acquire(c) == /\ pc[c] = "lock" /\ lock = 0
              /\ lock' = c /\ pc' = [pc EXCEPT ![c] = "recheck"]
              /\ UNCHANGED <<port, alive, completed, selected>>
Recheck(c) == /\ pc[c] = "recheck"
              /\ pc' = [pc EXCEPT ![c] = IF port = 3 THEN "complete" ELSE "probeInside"]
              /\ UNCHANGED <<port, lock, alive, completed, selected>>
Bind(c) == /\ pc[c] \in {"probeOutside", "probeInside"} /\ port = 0
           /\ port' = c
           /\ pc' = [pc EXCEPT ![c] = IF @ = "probeOutside" THEN "boundOutside" ELSE "boundInside"]
           /\ UNCHANGED <<lock, alive, completed, selected>>
Busy(c) == /\ pc[c] \in {"probeOutside", "probeInside"} /\ port # 0
           /\ pc' = [pc EXCEPT ![c] = IF @ = "probeOutside" THEN "lock" ELSE "kill"]
           /\ UNCHANGED <<port, lock, alive, completed, selected>>
CloseProbe(c) == /\ pc[c] \in {"boundOutside", "boundInside"} /\ port = c
                 /\ port' = 0
                 /\ pc' = [pc EXCEPT ![c] = IF @ = "boundOutside" THEN "lock" ELSE "spawn"]
                 /\ UNCHANGED <<lock, alive, completed, selected>>
Discover(c) == /\ pc[c] = "kill"
               /\ selected' = [selected EXCEPT ![c] = port]
               /\ pc' = [pc EXCEPT ![c] = "signal"]
               /\ UNCHANGED <<port, lock, alive, completed>>
Signal(c) == /\ pc[c] = "signal"
             /\ alive' = alive \ {selected[c]}
             /\ port' = IF port = selected[c] THEN 0 ELSE port
             /\ pc' = [pc EXCEPT ![c] = "spawn"]
             /\ UNCHANGED <<lock, completed, selected>>
Spawn(c) == /\ pc[c] = "spawn" /\ port = 0
            /\ port' = 3 /\ pc' = [pc EXCEPT ![c] = "complete"]
            /\ UNCHANGED <<lock, alive, completed, selected>>
Complete(c) == /\ pc[c] = "complete"
               /\ completed' = completed \cup {c}
               /\ lock' = IF lock = c THEN 0 ELSE lock
               /\ pc' = [pc EXCEPT ![c] = "done"]
               /\ UNCHANGED <<port, alive, selected>>
Done == /\ (completed = Clients \/ alive # Clients) /\ UNCHANGED vars
Next == (\E c \in alive: ReadVersion(c) \/ Acquire(c) \/ Recheck(c) \/ Bind(c)
        \/ Busy(c) \/ CloseProbe(c) \/ Discover(c) \/ Signal(c) \/ Spawn(c) \/ Complete(c)) \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ port \in 0..3 /\ lock \in 0..2
          /\ alive \subseteq Clients /\ completed \subseteq Clients
CallersSurvive == Contract!CallersSurvive
RefinesLifecycle == Contract!Spec
=============================================================================
