---------------------------- MODULE Recorder ----------------------------
EXTENDS Naturals, TLC
VARIABLES phase, extent, queued, fileSynced, target, directorySynced, clobbered
vars == <<phase, extent, queued, fileSynced, target, directorySynced, clobbered>>

Init == /\ phase = "active" /\ extent = "none" /\ queued = 0
        /\ fileSynced = FALSE /\ directorySynced = FALSE
        /\ target \in {"absent", "foreign"} /\ clobbered = FALSE
AdmitOutput == /\ phase = "active" /\ queued < 2 /\ queued' = queued + 1
               /\ UNCHANGED <<phase, extent, fileSynced, target, directorySynced, clobbered>>
Overflow == /\ phase = "active" /\ queued = 2 /\ phase' = "partial"
            /\ UNCHANGED <<extent, queued, fileSynced, target, directorySynced, clobbered>>
Drain == /\ queued > 0 /\ phase \in {"active", "finishing"} /\ queued' = queued - 1
         /\ UNCHANGED <<phase, extent, fileSynced, target, directorySynced, clobbered>>
StopInterval == /\ phase = "active" /\ phase' = "finishing" /\ extent' = "interval" /\ queued' = queued + 1
                /\ UNCHANGED <<fileSynced, target, directorySynced, clobbered>>
FinishProcess == /\ phase = "active" /\ phase' = "finishing" /\ extent' = "process" /\ queued' = queued + 1
                 /\ UNCHANGED <<fileSynced, target, directorySynced, clobbered>>
SyncFile == /\ phase = "finishing" /\ queued = 0 /\ ~fileSynced /\ fileSynced' = TRUE
            /\ UNCHANGED <<phase, extent, queued, target, directorySynced, clobbered>>
Publish == /\ phase = "finishing" /\ fileSynced /\ target = "absent" /\ target' = "owned"
           /\ clobbered' = (clobbered \/ target = "foreign")
           /\ UNCHANGED <<phase, extent, queued, fileSynced, directorySynced>>
TargetConflict == /\ phase = "finishing" /\ fileSynced /\ target = "foreign" /\ phase' = "partial"
                  /\ UNCHANGED <<extent, queued, fileSynced, target, directorySynced, clobbered>>
SyncDirectory == /\ phase = "finishing" /\ target = "owned" /\ ~directorySynced /\ directorySynced' = TRUE
                 /\ UNCHANGED <<phase, extent, queued, fileSynced, target, clobbered>>
Save == /\ phase = "finishing" /\ directorySynced /\ phase' = "saved"
        /\ UNCHANGED <<extent, queued, fileSynced, target, directorySynced, clobbered>>
Abort == /\ phase \in {"active", "finishing"} /\ phase' = "partial"
         /\ UNCHANGED <<extent, queued, fileSynced, target, directorySynced, clobbered>>
CleanupOwned == /\ phase = "partial" /\ target = "owned" /\ target' = "absent"
                /\ UNCHANGED <<phase, extent, queued, fileSynced, directorySynced, clobbered>>
Done == /\ phase \in {"saved", "partial"} /\ UNCHANGED vars
Next == AdmitOutput \/ Overflow \/ Drain \/ StopInterval \/ FinishProcess \/ SyncFile \/ Publish
        \/ TargetConflict \/ SyncDirectory \/ Save \/ Abort \/ CleanupOwned \/ Done

TypeOK == /\ phase \in {"active", "finishing", "saved", "partial"}
          /\ extent \in {"none", "interval", "process"} /\ queued \in 0..3
          /\ target \in {"absent", "foreign", "owned"}
          /\ fileSynced \in BOOLEAN /\ directorySynced \in BOOLEAN /\ clobbered \in BOOLEAN
NoClobber == ~clobbered
SavedIsDurable == phase = "saved" => (queued = 0 /\ fileSynced /\ target = "owned" /\ directorySynced)
SavedHasExtent == phase = "saved" => extent \in {"interval", "process"}
PayloadLeavesControlSlot == phase = "active" => queued <= 2
=============================================================================
