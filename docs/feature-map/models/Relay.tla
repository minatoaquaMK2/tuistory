------------------------------ MODULE Relay ------------------------------
EXTENDS TLC
VARIABLES phase, port, locked, killedCompatible, spawnedOccupied, unlockedMutation
vars == <<phase, port, locked, killedCompatible, spawnedOccupied, unlockedMutation>>

Init == /\ phase = "probe"
        /\ port \in {"empty", "older", "compatible", "wedged"}
        /\ locked = FALSE
        /\ killedCompatible = FALSE
        /\ spawnedOccupied = FALSE
        /\ unlockedMutation = FALSE

ProbeUsable == /\ phase = "probe" /\ port = "compatible"
               /\ phase' = "ready" /\ UNCHANGED <<port, locked, killedCompatible, spawnedOccupied, unlockedMutation>>
ProbeUnusable == /\ phase = "probe" /\ port # "compatible"
                 /\ phase' = "lock" /\ UNCHANGED <<port, locked, killedCompatible, spawnedOccupied, unlockedMutation>>
AcquireLock == /\ phase = "lock" /\ phase' = "recheck" /\ locked' = TRUE
               /\ port' \in {"empty", "older", "compatible", "wedged"}
               /\ UNCHANGED <<killedCompatible, spawnedOccupied, unlockedMutation>>
WaitForOwner == /\ phase = "lock" /\ phase' = "waitOwner"
                /\ UNCHANGED <<port, locked, killedCompatible, spawnedOccupied, unlockedMutation>>
RecheckUsable == /\ phase = "recheck" /\ port = "compatible"
                 /\ phase' = "ready" /\ locked' = FALSE
                 /\ UNCHANGED <<port, killedCompatible, spawnedOccupied, unlockedMutation>>
RecheckEmpty == /\ phase = "recheck" /\ port = "empty" /\ phase' = "spawn"
                /\ UNCHANGED <<port, locked, killedCompatible, spawnedOccupied, unlockedMutation>>
RecheckUnusable == /\ phase = "recheck" /\ port \in {"older", "wedged"} /\ phase' = "kill"
                   /\ UNCHANGED <<port, locked, killedCompatible, spawnedOccupied, unlockedMutation>>
KillFreed == /\ phase = "kill"
             /\ killedCompatible' = (killedCompatible \/ port = "compatible")
             /\ unlockedMutation' = (unlockedMutation \/ ~locked)
             /\ port' = "empty" /\ phase' = "spawn"
             /\ UNCHANGED <<locked, spawnedOccupied>>
KillStuck == /\ phase = "kill" /\ phase' = "failed" /\ locked' = FALSE
             /\ killedCompatible' = (killedCompatible \/ port = "compatible")
             /\ unlockedMutation' = (unlockedMutation \/ ~locked)
             /\ UNCHANGED <<port, spawnedOccupied>>
Spawn == /\ phase = "spawn" /\ port = "empty"
         /\ phase' = "waitNew" /\ port' = "starting"
         /\ spawnedOccupied' = (spawnedOccupied \/ port # "empty")
         /\ unlockedMutation' = (unlockedMutation \/ ~locked)
         /\ UNCHANGED <<locked, killedCompatible>>
NewReady == /\ phase = "waitNew" /\ phase' = "ready" /\ port' = "compatible" /\ locked' = FALSE
            /\ UNCHANGED <<killedCompatible, spawnedOccupied, unlockedMutation>>
NewTimeout == /\ phase = "waitNew" /\ phase' = "failed" /\ locked' = FALSE /\ port' = "empty"
              /\ UNCHANGED <<killedCompatible, spawnedOccupied, unlockedMutation>>
OwnerAcquired == /\ phase = "waitOwner" /\ phase' = "recheck" /\ locked' = TRUE
                 /\ port' \in {"empty", "older", "compatible", "wedged"}
                 /\ UNCHANGED <<killedCompatible, spawnedOccupied, unlockedMutation>>
OwnerTimeout == /\ phase = "waitOwner" /\ phase' = "failed"
                /\ UNCHANGED <<port, locked, killedCompatible, spawnedOccupied, unlockedMutation>>
Done == /\ phase \in {"ready", "failed"} /\ UNCHANGED vars
Next == ProbeUsable \/ ProbeUnusable \/ AcquireLock \/ WaitForOwner \/ RecheckUsable \/ RecheckEmpty
        \/ RecheckUnusable \/ KillFreed \/ KillStuck \/ Spawn \/ NewReady \/ NewTimeout \/ OwnerAcquired \/ OwnerTimeout \/ Done

TypeOK == /\ phase \in {"probe", "lock", "recheck", "kill", "spawn", "waitNew", "waitOwner", "ready", "failed"}
          /\ port \in {"empty", "older", "compatible", "wedged", "starting"}
          /\ locked \in BOOLEAN /\ killedCompatible \in BOOLEAN /\ spawnedOccupied \in BOOLEAN /\ unlockedMutation \in BOOLEAN
CompatibleNotKilled == ~killedCompatible
SpawnOnlyOnFreePort == ~spawnedOccupied
MutationHasLock == ~unlockedMutation
ReadyHasCompatibleDaemon == phase = "ready" => port = "compatible"
FinishedReleasesLock == phase \in {"ready", "failed"} => ~locked
=============================================================================
