----------------------------- MODULE OsLock -----------------------------
EXTENDS Naturals, FiniteSets, CoordinationContract
Actors == {1, 2}
VARIABLES a, holder
vars == <<a, holder>>
Init ==
  /\ a = [i \in Actors |-> [pc |-> "request", live |-> TRUE]]
  /\ holder = 0
\* Abstract kernel contract. Both descriptors refer to one stable lock object.
Acquire(i) ==
  /\ a[i].pc = "request" /\ holder = 0
  /\ holder' = i /\ a' = [a EXCEPT ![i].pc = "ready"]
Enter(i) ==
  /\ a[i].pc = "ready"
  /\ a' = [a EXCEPT ![i].pc = "inside"] /\ UNCHANGED holder
Return(i) ==
  /\ a[i].pc = "inside"
  /\ a' = [a EXCEPT ![i].pc = "release"] /\ UNCHANGED holder
Release(i) ==
  /\ a[i].pc = "release" /\ holder = i
  /\ holder' = 0 /\ a' = [a EXCEPT ![i].pc = "done"]
Timeout(i) ==
  /\ a[i].pc = "request"
  /\ a' = [a EXCEPT ![i].pc = "done"] /\ UNCHANGED holder
Crash(i) ==
  /\ a[i].live /\ a[i].pc \notin {"done", "crashed"}
  /\ a' = [a EXCEPT ![i].live = FALSE, ![i].pc = "crashed"]
  /\ holder' = IF holder = i THEN 0 ELSE holder
Step(i) ==
  Acquire(i) \/ Enter(i) \/ Return(i) \/ Release(i) \/ Timeout(i) \/ Crash(i)
Next == \E i \in Actors : Step(i)
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ (\A i \in Actors : WF_vars(Step(i)))
AllFinished == <> (\A i \in Actors : a[i].pc \in {"done", "crashed"})
MutualExclusion == Exclusive(a)
LiveOwnerKeepsClaim == RetainsClaim(a, [i \in Actors |-> holder = i])
TypeOK == holder \in 0..2 /\ \A i \in Actors : a[i].live \in BOOLEAN
=============================================================================
