--------------------------- MODULE LegacyLock ---------------------------
EXTENDS Naturals, Integers, FiniteSets, CoordinationContract
Actors == {1, 2}
VARIABLES a, file, payload, expired
vars == <<a, file, payload, expired>>
Init ==
  /\ a = [i \in Actors |-> [pc |-> "open", live |-> TRUE, observed |-> -1]]
  /\ file = 0 /\ payload = [i \in Actors |-> 0] /\ expired = {}

\* wx opens a distinct inode before writeFileSync writes its payload.
\* An unlinked but open inode remains writable through the caller's descriptor.
Open(i) ==
  /\ a[i].pc \in {"open", "retry"}
  /\ IF file = 0 THEN
       /\ file' = i /\ payload' = [payload EXCEPT ![i] = 0]
       /\ a' = [a EXCEPT ![i].pc = "write"]
     ELSE
       /\ UNCHANGED <<file, payload>>
       /\ a' = [a EXCEPT ![i].pc = IF @ = "open" THEN "read" ELSE "done"]
  /\ UNCHANGED expired
WritePayload(i) ==
  /\ a[i].pc = "write"
  /\ payload' = [payload EXCEPT ![i] = i]
  /\ a' = [a EXCEPT ![i].pc = "ready"]
  /\ UNCHANGED <<file, expired>>
Read(i) ==
  /\ a[i].pc = "read"
  /\ a' = [a EXCEPT ![i].observed = IF file = 0 THEN -1 ELSE payload[file],
                   ![i].pc = "check"]
  /\ UNCHANGED <<file, payload, expired>>
CheckStale(i) ==
  /\ a[i].pc = "check"
  /\ LET owner == a[i].observed IN
     a' = [a EXCEPT ![i].pc =
       IF owner \in Actors THEN
         IF owner \in expired \/ ~a[owner].live THEN "unlink" ELSE "done"
       ELSE "done"]
  /\ UNCHANGED <<file, payload, expired>>
UnlinkStale(i) ==
  /\ a[i].pc = "unlink"
  /\ file' = 0 /\ a' = [a EXCEPT ![i].pc = "retry"]
  /\ UNCHANGED <<payload, expired>>
Enter(i) ==
  /\ a[i].pc = "ready"
  /\ a' = [a EXCEPT ![i].pc = "inside"]
  /\ UNCHANGED <<file, payload, expired>>
Return(i) ==
  /\ a[i].pc = "inside"
  /\ a' = [a EXCEPT ![i].pc = "release-read"]
  /\ UNCHANGED <<file, payload, expired>>
ReleaseRead(i) ==
  /\ a[i].pc = "release-read"
  /\ a' = [a EXCEPT ![i].pc =
       IF file = 0 THEN "done"
       ELSE IF payload[file] = i THEN "release-unlink" ELSE "done"]
  /\ UNCHANGED <<file, payload, expired>>
ReleaseUnlink(i) ==
  /\ a[i].pc = "release-unlink"
  /\ file' = 0 /\ a' = [a EXCEPT ![i].pc = "done"]
  /\ UNCHANGED <<payload, expired>>
ClockExpires(i) ==
  /\ payload[i] = i /\ i \notin expired
  /\ expired' = expired \cup {i}
  /\ UNCHANGED <<a, file, payload>>
Crash(i) ==
  /\ a[i].live /\ a[i].pc \notin {"done", "crashed"}
  /\ a' = [a EXCEPT ![i].live = FALSE, ![i].pc = "crashed"]
  /\ UNCHANGED <<file, payload, expired>>
Next == \E i \in Actors :
  Open(i) \/ WritePayload(i) \/ Read(i) \/ CheckStale(i) \/ UnlinkStale(i) \/
  Enter(i) \/ Return(i) \/ ReleaseRead(i) \/ ReleaseUnlink(i) \/
  ClockExpires(i) \/ Crash(i)
Spec == Init /\ [][Next]_vars
MutualExclusion == Exclusive(a)
LiveOwnerKeepsClaim == RetainsClaim(a, [i \in Actors |-> file = i])
TypeOK ==
  /\ file \in 0..2 /\ expired \subseteq Actors
  /\ \A i \in Actors : payload[i] \in {0, i} /\ a[i].live \in BOOLEAN
=============================================================================
