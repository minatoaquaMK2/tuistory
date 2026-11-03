-------------------------- MODULE LifecycleContract --------------------------
EXTENDS FiniteSets
CONSTANT Clients
VARIABLES callers, available, completed
vars == <<callers, available, completed>>

Init == /\ callers = Clients
        /\ available = FALSE
        /\ completed = {}

Start == /\ ~available
         /\ available' = TRUE
         /\ UNCHANGED <<callers, completed>>
Stop == /\ available
        /\ available' = FALSE
        /\ UNCHANGED <<callers, completed>>
Complete(c) == /\ c \in callers \ completed /\ available
               /\ completed' = completed \cup {c}
               /\ UNCHANGED <<callers, available>>
Next == Start \/ Stop \/ (\E c \in Clients: Complete(c))
Spec == Init /\ [][Next]_vars

CallersSurvive == callers = Clients
=============================================================================
