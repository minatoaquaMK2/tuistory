--------------------------- MODULE TicketLock ---------------------------
EXTENDS Naturals, FiniteSets, Sequences, CoordinationContract
CONSTANTS SkipPostScan, SaturateTicket, CoherentListing
Actors == {1, 2}
Other(i) == 3 - i
VARIABLE a
vars == <<a>>

Init == a = [i \in Actors |->
  [pc |-> "new", live |-> TRUE, present |-> FALSE,
   ticket |-> 0, number |-> 1, tmp |-> FALSE]]

Listed(i, found) ==
  IF CoherentListing THEN found = a[Other(i)].present
  ELSE found \in {FALSE, a[Other(i)].present}

Register(i) ==
  /\ a[i].pc = "new"
  /\ a' = [a EXCEPT ![i].present = TRUE, ![i].pc = "choose-list"]
ChooseList(i) ==
  /\ a[i].pc = "choose-list"
  /\ \E found \in BOOLEAN :
       /\ Listed(i, found)
       /\ a' = [a EXCEPT ![i].pc = IF found THEN "choose-probe" ELSE "write"]
Probe(i, stage) ==
  /\ a[i].pc = stage \o "-probe"
  /\ a' = [a EXCEPT ![i].pc = stage \o
       (IF a[Other(i)].live THEN "-read" ELSE "-remove-ticket")]
RemoveDeadTicket(i, stage) ==
  /\ a[i].pc = stage \o "-remove-ticket"
  /\ a' = [a EXCEPT ![Other(i)].ticket = 0, ![Other(i)].tmp = FALSE,
                   ![i].pc = stage \o "-remove-dir"]
RemoveDeadDirectory(i, stage) ==
  /\ a[i].pc = stage \o "-remove-dir"
  /\ a' = [a EXCEPT ![Other(i)].present = FALSE,
                   ![i].pc = IF stage = "choose" THEN "write" ELSE "ready"]
ChooseRead(i) ==
  /\ a[i].pc = "choose-read"
  /\ a' = [a EXCEPT
       ![i].number = IF a[Other(i)].ticket >= a[i].number
                       THEN IF SaturateTicket THEN 1 ELSE a[Other(i)].ticket + 1
                       ELSE @,
       ![i].pc = IF a[Other(i)].ticket = 0 THEN "choose-stat" ELSE "write"]
ChooseStat(i) ==
  /\ a[i].pc = "choose-stat"
  /\ a' = [a EXCEPT ![i].pc = "write"]
WriteTemporary(i) ==
  /\ a[i].pc = "write"
  /\ a' = [a EXCEPT ![i].tmp = TRUE, ![i].pc = "publish"]
Publish(i) ==
  /\ a[i].pc = "publish"
  /\ a' = [a EXCEPT ![i].ticket = a[i].number, ![i].tmp = FALSE,
       ![i].pc = IF SkipPostScan THEN "ready" ELSE "wait-list"]
WaitList(i) ==
  /\ a[i].pc = "wait-list"
  /\ \E found \in BOOLEAN :
       /\ Listed(i, found)
       /\ a' = [a EXCEPT ![i].pc = IF found THEN "wait-probe" ELSE "ready"]
Precedes(j, i) ==
  a[j].ticket < a[i].number \/ (a[j].ticket = a[i].number /\ j < i)
WaitRead(i) ==
  /\ a[i].pc = "wait-read"
  /\ a' = [a EXCEPT ![i].pc =
       IF a[Other(i)].ticket = 0 THEN "wait-stat"
       ELSE IF Precedes(Other(i), i) THEN "wait-list" ELSE "ready"]
WaitStat(i) ==
  /\ a[i].pc = "wait-stat"
  /\ a' = [a EXCEPT ![i].pc = IF a[Other(i)].present THEN "wait-list" ELSE "ready"]
Enter(i) ==
  /\ a[i].pc = "ready"
  /\ a' = [a EXCEPT ![i].pc = "inside"]
Return(i) ==
  /\ a[i].pc = "inside"
  /\ a' = [a EXCEPT ![i].pc = "cleanup-ticket"]
Timeout(i) ==
  /\ a[i].pc = "wait-list"
  /\ a' = [a EXCEPT ![i].pc = "cleanup-ticket"]
CleanupTicket(i) ==
  /\ a[i].pc = "cleanup-ticket"
  /\ a' = [a EXCEPT ![i].ticket = 0, ![i].tmp = FALSE, ![i].pc = "cleanup-dir"]
CleanupDirectory(i) ==
  /\ a[i].pc = "cleanup-dir"
  /\ a' = [a EXCEPT ![i].present = FALSE, ![i].pc = "done"]
Crash(i) ==
  /\ a[i].live /\ a[i].pc \notin {"done", "crashed"}
  /\ a' = [a EXCEPT ![i].live = FALSE, ![i].pc = "crashed"]

Step(i) ==
  Register(i) \/ ChooseList(i) \/ ChooseRead(i) \/ ChooseStat(i) \/
  WriteTemporary(i) \/ Publish(i) \/ WaitList(i) \/ WaitRead(i) \/ WaitStat(i) \/
  Enter(i) \/ Return(i) \/ Timeout(i) \/ CleanupTicket(i) \/ CleanupDirectory(i) \/
  Crash(i) \/ (\E stage \in {"choose", "wait"} :
    Probe(i, stage) \/ RemoveDeadTicket(i, stage) \/ RemoveDeadDirectory(i, stage))

Next == \E i \in Actors : Step(i)
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ (\A i \in Actors : WF_vars(Step(i)))
AllFinished == <> (\A i \in Actors : a[i].pc \in {"done", "crashed"})
MutualExclusion == Exclusive(a)
LiveOwnerKeepsClaim == RetainsClaim(a,
  [i \in Actors |-> a[i].present /\ a[i].ticket > 0])
TypeOK == \A i \in Actors :
  /\ a[i].live \in BOOLEAN /\ a[i].present \in BOOLEAN /\ a[i].tmp \in BOOLEAN
  /\ a[i].ticket \in 0..2 /\ a[i].number \in 1..2
=============================================================================
