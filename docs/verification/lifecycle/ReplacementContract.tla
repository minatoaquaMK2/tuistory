------------------------- MODULE ReplacementContract -------------------------
EXTENDS FiniteSets
VARIABLES live, sessions
vars == <<live, sessions>>
Init == /\ live = {"old"} /\ sessions = {}
RetireOld == /\ live' = live \ {"old"}
             /\ sessions' = sessions \ {"old"}
StartSuccessor == /\ "old" \notin live /\ "successor" \notin live
                  /\ live' = live \cup {"successor"} /\ UNCHANGED sessions
UseSuccessor == /\ "successor" \in live
                /\ sessions' = sessions \cup {"successor"} /\ UNCHANGED live
Next == RetireOld \/ StartSuccessor \/ UseSuccessor
Spec == Init /\ [][Next]_vars
=============================================================================
