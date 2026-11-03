# Recording, export and screenshots

## F08. Recording lifecycle

Launch with `record: { path }` or CLI `--record`. Preparation validates geometry and queue limits, rejects an existing destination, exclusively opens `path.partial`, and writes an asciicast v3 header before spawning the PTY. [Preparation](../../src/recording.ts#L87), [session factory](../../src/session.ts#L56).

The handle exposes `mark`, `status`, and `stop`. Output, resize, and markers enter one ordered encoded-byte queue. The default capacity is 4 MiB. Ordinary events reserve 128 bytes for a final control event. Overflow stops further admission and reports a partial recording. [Handle](../../src/recording.ts#L46), [queue admission](../../src/recording.ts#L199).

| State/event | Result |
| --- | --- |
| Active + manual stop | Add quiet-tail marker; finish an interval; child remains alive |
| Active + real process completion and EOF | Add actual exit status; finish a process recording |
| Active + overflow, serialization failure or abort | Enter partial and stop accepting events |
| Finishing + successful drain, sync, close, hard link and directory sync | Enter saved with interval or process extent |
| Finishing + I/O failure or five-second deadline | Enter partial; attempt cleanup of an owned published link |
| Repeated finish/stop | Return shared completion promise |
| Saved + abort | Preserve saved result |

[State union](../../src/recording.ts#L52), [stop and process finish](../../src/recording.ts#L161), [abort](../../src/recording.ts#L187), [publication](../../src/recording.ts#L246).

| ID | Candidate property | Evidence and limit |
| --- | --- | --- |
| C1 | Admitted events form an ordered contiguous prefix; no output/resize admission after leaving active | [Overflow prefix](../../src/recording.test.ts#L48); serialized byte size matters |
| C2 | Queue usage stays within its capacity; ordinary events preserve control reserve | [Encoded-byte accounting](../../src/recording.test.ts#L273); starter model uses unit events, not arbitrary byte lengths |
| C3 | Saved requires successful publication; existing targets are never replaced | [Late-created target](../../src/recording.test.ts#L62); crashes and external replacement need a stronger filesystem model |
| C4 | Manual stop never fabricates a process-exit record; finish callers share one operation | [Quiet tail](../../src/recording.test.ts#L27), [manual stop with live child](../../src/recording.test.ts#L118) |

`partial` does not imply the destination is absent at every instant. The timeout explicitly reports publication as unconfirmed. Cleanup compares device and inode before removing an owned link. Abort during link or directory sync, delayed filesystem success after timeout, target replacement, and power-loss durability are future verification cases. [Ownership cleanup](../../src/recording.ts#L277), [deadline](../../src/recording.ts#L287).

## F09. Video export

`exportRecording()` and the offline CLI export command read asciicast v3 without starting a daemon. Parsing validates UTF-8, version, events, nonnegative time deltas, geometry, and limits. Unknown event codes still contribute elapsed time. Planning applies speed, capped idle intervals, clipping, and constant-frame-rate sampling. The final frame samples the source endpoint. [Parser](../../src/recording.ts#L382), [plan](../../src/recording.ts#L481), [endpoint sampling](../../src/recording.ts#L524).

Export replays terminal state, renders through up to two workers, and feeds frames to FFmpeg in planned order. Worker completion order does not choose encoder order. Unchanged frames reuse pixels. Publication requires successful encoder exit, successful worker close, nonempty output, file sync, and a no-replacement hard link. Temporary data is removed in `finally`. [Export](../../src/recording.ts#L611), [ordered frame queue](../../src/recording.ts#L651), [publication](../../src/recording.ts#L707).

The observable result is an MP4 plus frame count, dimensions and duration. Candidate properties include monotone source replay, correct endpoint sampling, stable encoded order, no overwrite, and no publication after encoder or pool failure. Tests cover [hostile input](../../src/recording.test.ts#L423), [timing transforms](../../src/recording.test.ts#L443), [CFR endpoint](../../src/recording.test.ts#L460), [publication race](../../src/recording.test.ts#L563), [encoder failure](../../src/recording.test.ts#L604), and [worker ordering and cleanup](../../src/recording.test.ts#L889). FFmpeg-dependent skips must remain visible in reports.

## F10 and F11. Screenshots and worker ownership

`renderTerminalImage()` and CLI screenshot return or write PNG data. The render plan bounds physical pixel size, not just logical terminal cells. Screenshots permit at most two concurrent jobs under a shared pixel budget. A timed-out request retains its reservation until its workers actually exit. PNG and video RGBA share the rasterizer. Workers use bundled fonts and disable system font loading. [Screenshot entry](../../src/recording.ts#L1276), [plan and admission](../../src/recording.ts#L982), [rasterizer](../../src/recording.ts#L1221).

| State owner | Values | Ownership |
| --- | --- | --- |
| Pool | Starting, active, closing, closed, failed | One export or screenshot request |
| Slot | Starting, idle, busy(job), stopping, exited | One worker process/thread and at most one job |
| Screenshot admission | Reserved, released | Released only after spawning ends and all slots exit |

[Pool state](../../src/recording.ts#L750), [pool implementation](../../src/recording.ts#L769), [worker protocol](../../src/recording-render-worker.ts#L21).

| ID | Candidate property | Existing evidence |
| --- | --- | --- |
| W1 | Only a matching job ID, dimensions and validated payload resolve a busy slot | [Malformed and bad-ID replies](../../src/recording.test.ts#L708), [duplicate replies](../../src/recording.test.ts#L719) |
| W2 | First failure remains authoritative; failure settles pending work; close cannot report success before required acknowledgment | [Pending close](../../src/recording.test.ts#L747), [encoder abort](../../src/recording.test.ts#L837), [shutdown timeout](../../src/recording.test.ts#L857) |
| W3 | Worker ownership and screenshot admission survive request timeout until actual exit | [Pool isolation](../../src/recording.test.ts#L755), [reservation after timeout](../../src/recording.test.ts#L773) |

Image checks cover [retina geometry](../../src/recording.test.ts#L1061), [concurrent capacity](../../src/recording.test.ts#L1071), [physical pixel limits](../../src/recording.test.ts#L1083), and [PNG/RGBA equality](../../src/recording.test.ts#L1094). A state model can prove admission and ownership under its assumptions; glyph appearance and pixel fidelity require image assertions. The first starter models exclude worker pools and export timing.
