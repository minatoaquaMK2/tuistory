------------------------------ MODULE Escalation ------------------------------
EXTENDS FiniteSets
CONSTANT KeepTargets
VARIABLES phase, port, live, sessions, victims, selected, retired
vars == <<phase, port, live, sessions, victims, selected, retired>>
Contract == INSTANCE ReplacementContract

Init == /\ phase = "term" /\ port = "old" /\ live = {"old"}
        /\ sessions = {} /\ victims = {} /\ selected = "none" /\ retired = FALSE
SendTerm == /\ phase = "term"
            /\ victims' = victims \cup {"old"} /\ phase' = "wait"
            /\ UNCHANGED <<port, live, sessions, selected, retired>>
OldExit == /\ "old" \in live /\ phase \in {"wait", "discover", "kill"}
           /\ live' = live \ {"old"} /\ port' = "free"
           /\ UNCHANGED <<phase, sessions, victims, selected, retired>>
SuccessorBinds == /\ port = "free" /\ ~retired
                  /\ live' = live \cup {"successor"} /\ port' = "successor" /\ retired' = TRUE
                  /\ UNCHANGED <<phase, sessions, victims, selected>>
LaunchSession == /\ "successor" \in live
                 /\ sessions' = sessions \cup {"successor"}
                 /\ UNCHANGED <<phase, port, live, victims, selected, retired>>
WaitEnds == /\ phase = "wait"
            /\ phase' = IF port = "free" THEN "done" ELSE "discover"
            /\ UNCHANGED <<port, live, sessions, victims, selected, retired>>
Discover == /\ phase = "discover"
            /\ selected' = port /\ phase' = "kill"
            /\ UNCHANGED <<port, live, sessions, victims, retired>>
SendKill == /\ phase = "kill"
            /\ LET kill == selected \in {"old", "successor"} /\ (~KeepTargets \/ selected = "old")
               IN /\ victims' = IF kill THEN victims \cup {selected} ELSE victims
                  /\ live' = IF kill THEN live \ {selected} ELSE live
                  /\ sessions' = IF kill THEN sessions \ {selected} ELSE sessions
                  /\ port' = IF kill /\ port = selected THEN "free" ELSE port
            /\ phase' = "done" /\ UNCHANGED <<selected, retired>>
Done == /\ phase = "done" /\ UNCHANGED vars
Next == SendTerm \/ OldExit \/ SuccessorBinds \/ LaunchSession \/ WaitEnds \/ Discover \/ SendKill \/ Done
Spec == Init /\ [][Next]_vars
TargetDoesNotExpand == victims \subseteq {"old"}
RefinesReplacement == Contract!Spec
=============================================================================
