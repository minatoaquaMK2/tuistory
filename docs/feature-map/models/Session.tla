----------------------------- MODULE Session -----------------------------
EXTENDS Naturals, TLC
VARIABLES life, process, output, completion, closeNotices, cleaned, illegalWrite
vars == <<life, process, output, completion, closeNotices, cleaned, illegalWrite>>
Init == /\ life = "open" /\ process = "alive" /\ output = "open" /\ completion = FALSE
        /\ closeNotices = 0 /\ cleaned = FALSE /\ illegalWrite = FALSE
Write == /\ life = "open" /\ process = "alive"
         /\ illegalWrite' = (illegalWrite \/ life # "open" \/ process # "alive")
         /\ UNCHANGED <<life, process, output, completion, closeNotices, cleaned>>
Exit == /\ process = "alive" /\ process' = "exited"
        /\ cleaned' = (cleaned \/ life = "disposed")
        /\ UNCHANGED <<life, output, completion, closeNotices, illegalWrite>>
DrainEOF == /\ process = "exited" /\ output = "open" /\ life # "disposed"
            /\ output' = "eof" /\ completion' = TRUE
            /\ UNCHANGED <<life, process, closeNotices, cleaned, illegalWrite>>
DrainFailure == /\ process = "exited" /\ output = "open" /\ life # "disposed"
                /\ output' = "incomplete" /\ completion' = TRUE
                /\ UNCHANGED <<life, process, closeNotices, cleaned, illegalWrite>>
Close == /\ life = "open" /\ life' = "closing" /\ closeNotices' = closeNotices + 1
         /\ UNCHANGED <<process, output, completion, cleaned, illegalWrite>>
CloseComplete == /\ life = "closing" /\ completion /\ life' = "disposed"
                 /\ cleaned' = (process = "exited")
                 /\ UNCHANGED <<process, output, completion, closeNotices, illegalWrite>>
CloseDeadline == /\ life = "closing" /\ ~completion /\ life' = "disposed"
                 /\ output' = "incomplete" /\ cleaned' = (process = "exited")
                 /\ UNCHANGED <<process, completion, closeNotices, illegalWrite>>
RepeatClose == /\ life \in {"closing", "disposed"} /\ UNCHANGED vars
RetainSnapshot == /\ life = "open" /\ process = "exited" /\ completion /\ UNCHANGED vars
Next == Write \/ Exit \/ DrainEOF \/ DrainFailure \/ Close \/ CloseComplete \/ CloseDeadline \/ RepeatClose \/ RetainSnapshot
TypeOK == /\ life \in {"open", "closing", "disposed"} /\ process \in {"alive", "exited"}
          /\ output \in {"open", "eof", "incomplete"} /\ completion \in BOOLEAN
          /\ closeNotices \in 0..1 /\ cleaned \in BOOLEAN /\ illegalWrite \in BOOLEAN
NoWriteAfterCloseOrExit == ~illegalWrite
CloseNotifiesOnce == (life # "open") => closeNotices = 1
CleanupRequiresExit == cleaned => (process = "exited" /\ life = "disposed")
EOFRequiresExit == output = "eof" => process = "exited"
=============================================================================
