# Terminal automation and process completion

## F03. Create a terminal

`launchTerminal()` creates the session, normally waits for first output and idle, then returns it. `waitForData:false` bypasses readiness. Readiness failure closes the session before rejection. Direct `new Session()` creates an unrecorded session; recording requires the async factory. [Factory](../../src/index.ts#L8), [recording preparation](../../src/session.ts#L56), [constructor](../../src/session.ts#L277).

Plain Bun sessions use `Bun.spawn({terminal})`. Plain Node sessions use `zigpty`. Recorded sessions use the native adapter under both runtimes and reject Windows. The native adapter exposes independent `exited` and `drained` promises. EOF may occur before process exit, or descendants may retain the PTY after the main process exits. [Bun](../../src/pty-bun.ts#L19), [Node](../../src/pty-node.ts#L20), [native completion](../../src/pty-native.ts#L68).

Evidence includes [echo launch](../../src/index.test.ts#L7), [interactive cat](../../src/index.test.ts#L113), [recorded immediate output](../../src/recording.test.ts#L103), and [plain Bun without recording dependency](../../src/session-close.test.ts#L268).

## F04. Input

| Public API | Behavior and guard | Evidence |
| --- | --- | --- |
| `Session.type` | Write text, then wait for settling | [implementation](../../src/session.ts#L630), [interactive shell](../../src/index.test.ts#L144) |
| `Session.press` | Encode simultaneous key chord, write, then wait | [implementation](../../src/session.ts#L694), [CLI invalid keys](../../src/cli.test.ts#L413) |
| `Session.sendKey`, `Session.writeRaw` | Synchronous key or raw input | [sendKey](../../src/session.ts#L705), [raw write](../../src/session.ts#L625) |
| `Session.click` | Search visible text; skip empty regex matches; reject multiple matches unless `first`; use native terminal-cell coordinates | [implementation](../../src/session.ts#L916), [multiple match tests](../../src/index.test.ts#L343) |
| `Session.clickAt` | Send mouse click at zero-based coordinates | [implementation](../../src/session.ts#L970); dedicated boundary test not identified |
| `Session.scrollUp`, `Session.scrollDown` | Send SGR wheel events at supplied or centered coordinates | [implementation](../../src/session.ts#L984); dedicated event-count test not identified |

`assertWritable()` rejects actual writes after observed process death, closing, or disposal. A modifier-only key chord can be a no-op, so “every input method throws after close” is too broad. [Write guard](../../src/session.ts#L561), [key encoding](../../src/session.ts#L643).

The native input queue preserves order across partial writes and retries `EAGAIN`. Its future verification boundary needs write callbacks, disposal, and descriptor ownership. Dedicated arbitrary partial-write/interleaving tests were not identified. [Native write queue](../../src/pty-native.ts#L143).

## F05 and F06. Observation and waits

| Public API | Observable semantics | Evidence |
| --- | --- | --- |
| `Session.text` | Snapshot with optional style filters, trimming, cursor, predicate and immediate mode | [snapshot implementation](../../src/session.ts#L795) |
| `Session.waitForText` | Literal string or regex wait over screen text | [implementation](../../src/session.ts#L863), [literal](../../src/index.test.ts#L176), [regex](../../src/index.test.ts#L208) |
| `Session.waitForData` | Success requires at least one output callback; silent exit rejects | [implementation](../../src/session.ts#L571), [silent exit](../../src/session-close.test.ts#L161) |
| `Session.waitIdle` | Wait for quiet interval or timeout; timeout resolves successfully | [implementation](../../src/session.ts#L597), [idle delay tests](../../src/index.test.ts#L33) |
| `Session.waitForExit` | Resolve true on real child exit, false on timeout | [implementation](../../src/session.ts#L501), [exit after disposal](../../src/session-close.test.ts#L193) |
| `Session.captureFrames` | Send a key and sample immediate snapshots | [implementation](../../src/session.ts#L891); dedicated active test not identified |
| `Session.read` | Convert unread retained chunks to text and advance the session-wide cursor | [implementation](../../src/session.ts#L1018), [CLI consumption](../../src/cli.test.ts#L882) |
| `Session.readAll`, `Session.getRawOutput` | Read retained output without advancing the cursor; raw form keeps terminal escapes | [implementation](../../src/session.ts#L1041), [non-consuming read](../../src/cli.test.ts#L916) |
| `Session.hasUnreadOutput` | Compare read cursor with retained chunks | [implementation](../../src/session.ts#L1050) |
| `Session.getTerminalData`, `Session.getVisibleTerminalData` | Return terminal data for rendering or visible-only inspection | [implementation](../../src/session.ts#L1064), [render tests](../../src/index.test.ts#L596) |

| ID | Candidate property | Required limitation |
| --- | --- | --- |
| O1 | Incremental reads consume each retained chunk at most once; all/raw reads do not consume | Model chunk eviction and one shared cursor, not one cursor per client |
| O2 | A wait settles by its condition, exit/closure, or timeout | Timers require event-loop progress. `waitIdle` timeout is success, not a quietness proof |
| O3 | Recorded final output remains eligible for text waits until drain completes or the tail deadline expires | Process exit alone is insufficient; [final output test](../../src/recording.test.ts#L139) |

The retained buffer is bounded by JavaScript character counts with an exception for one oversized chunk. It is not a strict one-megabyte buffer. `text()` evaluates a predicate, waits again, and returns a fresh snapshot; a transient match need not survive in the returned snapshot. [Session interaction tests](../../src/session-interaction.test.ts) cover global/sticky regex reuse without mutating caller state, released idle waiters, native click columns, visible rows, and finite empty matches. Style filtering, eviction-cursor interaction and frame capture still need dedicated coverage. [Retention loop](../../src/session.ts#L335), [predicate polling](../../src/session.ts#L833).

## F07. Lifecycle, metadata and cleanup

| Public API | Role | Source |
| --- | --- | --- |
| `Session.isDead`, `Session.exitInfo`, `Session.exitedAt`, `Session.startedAt` | Observed process state and timestamps | [fields](../../src/session.ts#L267), [getter](../../src/session.ts#L429) |
| `Session.currentCols`, `Session.currentRows`, `Session.currentCwd`, `Session.currentCommand`, `Session.currentEnv` | Session metadata used by listing and restart | [getters](../../src/session.ts#L433) |
| `Session.subscribe` | Subscribe to raw output; returns unsubscribe | [subscription](../../src/session.ts#L457) |
| `Session.onExit` | Observe actual child exit, including after disposal; returns an independent unsubscribe | [exit listener](../../src/session.ts#L473) |
| `Session.onClosing` | Receive first close reason before subscribers are cleared; returns unsubscribe | [close listener](../../src/session.ts#L492) |
| `Session.killProcess` | Signal the process group while retaining terminal and metadata | [kill](../../src/session.ts#L466) |
| `Session.resize` | Validate positive integer dimensions, update terminal, recorder and PTY | [resize](../../src/session.ts#L1073) |
| `Session.close`, `Session.closeAsync` | Start one closure operation; async form exposes its shared promise | [close](../../src/session.ts#L1086) |
| `Session.recording` | Optional recording handle | [field](../../src/session.ts#L250), [recording feature](recording.md) |

Use separate state dimensions when modeling.

| Dimension | Values | Transition owner |
| --- | --- | --- |
| Process | Alive, exited with result | PTY exit callback |
| Session resource | Open, closing, disposed | `closeAsync`, `finishClose`, `disposeSession` |
| Output | Open, EOF, incomplete | Plain exit or native completion |
| Recording | Absent, active, finishing, saved, partial | Recorder |

Plain close disposes the terminal synchronously and need not await child exit. Recorded close waits for completion with a five-second race, then disposes. After main-process exit, the recorded path allows 200 ms for output drain. Missing EOF aborts the recording. Abort and filesystem work themselves still require progress. [Exit handling](../../src/session.ts#L374), [recorded completion](../../src/session.ts#L393), [close ordering](../../src/session.ts#L1090).

| ID | Candidate property | Existing evidence |
| --- | --- | --- |
| S1 | No actual PTY write or resize after close begins or death is observed | Write guard; include native queued writes in a stronger future model |
| S2 | Reentrant/repeated close uses one operation; close listeners fire once before disposal | [plain reentrancy](../../src/session-close.test.ts#L108), [recorded reentrancy](../../src/recording.test.ts#L185) |
| S3 | Disposal does not fabricate process exit; exit waiters retain the real result | [pending and later waiters](../../src/session-close.test.ts#L193) |
| S4 | Generated TERMCAST cleanup is attempted only after real exit; caller-owned suffixes remain | [generated cleanup](../../src/index.test.ts#L253), [explicit suffix](../../src/index.test.ts#L299), [shutdown output](../../src/session-close.test.ts#L240) |

Cleanup errors are swallowed, so an attempted removal does not prove a file disappeared. POSIX termination targets the process group, then escalates after two seconds. Escaped descendants are outside that group. The unreferenced escalation timer can be lost if the caller exits. `closeAsync()` does not prove every descendant is gone. [Process-group implementation](../../src/kill-process-group.ts#L23).

Resize updates are sequential, not transactional. Recorded geometry rejection is tested before changes; downstream terminal or PTY failure needs separate modeling. [Rejected geometry](../../src/recording.test.ts#L245). The [recorded-session chart](statecharts.md) covers a reduced exit/close flow and states its assumptions.
