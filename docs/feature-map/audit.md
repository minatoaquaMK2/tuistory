# Bug audit and repairs

The audit reproduced failures on real CLI processes, WebSockets, PTYs and the attach TUI before changing production code. The baseline was `2bc5b367bda0ab0da8009e0141d2345317c8f78e`. The repairs and regression tests are included in this repository.

| ID | Confirmed behavior before repair | Repair and regression |
| --- | --- | --- |
| B01 | A live restart owner paused beyond ten seconds lost ownership; resuming it destroyed the replacement session | [Unique contender tickets](../../src/relay-lock.ts) replace age eviction; [lock tests](../../src/relay-lock.test.ts) and [real lifecycle tests](../../src/relay-lifecycle.test.ts) cover suspension, death, contention and stop/start ordering |
| B02 | A `/version` response of `{}` crashed at `undefined.split` | Validate SemVer at the response boundary; malformed responses use port probing; lifecycle tests preserve healthy newer prerelease/build versions |
| B03 | `click(/^/)` blocked the event loop despite its timeout | Finite match iteration skips empty matches; a subprocess regression verifies completion |
| B04 | A visible target on row3 emitted mouse row6 after scrollback | Search only the visible terminal rows |
| B05 | A target after `界` received mouse column2 instead of3 | Measure offsets with Ghostty's own terminal geometry, including combining and emoji cases |
| B06 | Reusing `/READY/g` falsely failed and changed the caller's lastIndex | Each wait owns a regex copy and resets it for every snapshot |
| B07 | Thirty completed idle timeouts retained thirty callbacks under continuous output | Timeout, idle and teardown settle through the same callback cleanup |
| B08 | Reattach duplicated output; switching A to B retained A's events and closure; already-dead attach sent two exits | One actual Session binding owns data, exit and closing subscriptions; onExit returns an independent unsubscribe |
| B09 | Bracketed paste in the real TUI dropped its contents | Handle OpenTUI paste bytes and frame decoded input, preserving pending Ctrl ordering |
| B10 | PTY output resembling an exit JSON message falsely ended the UI while the process remained alive | Protocol2 acknowledges negotiation and separates data/input envelopes from controls; legacy clients retain their protocol |
| B11 | An empty abandoned restart file prevented every future startup | New lock records identify their owner in the unique pathname; obsolete legacy files are not consulted |
| B12 | A stale PID file made daemon-stop kill an unrelated live process | Signal the listener discovered by port; PID text is diagnostic only |
| B13 | A pending Ctrl timer erased exit, closing or negotiation-error status | Ended connections cancel pending Ctrl state and reject further input while preserving Ctrl+C detach |
| B16 | The first paste repair dropped a leading U+FEFF | Decode paste with `ignoreBOM:true`; the real TUI regression verifies the complete UTF-8 bytes |

B03 through B07 and subscription disposal are covered by [Session interaction tests](../../src/session-interaction.test.ts). B08 through B10, B13 and B16 have [real attach and TUI regressions](../../src/attach.test.ts). The root README's `log-path` example was also corrected to the registered `logfile` command.

## Regressions caught before handoff

Independent review caught two problems in the first B12 repair. B14 killed a separate IPv6 listener at the same numeric port. B15 crashed with an unhandled subprocess error when `lsof` was missing from PATH. Both were reproduced against the original baseline and the repair under Bun and Node. They did not ship.

The final [listener discovery](../../src/relay-listener.ts) selects only IPv4 loopback or wildcard TCP listeners. macOS uses its system `lsof` with structured fields, Linux maps socket inodes through procfs, and Windows uses system TCP netstat records. No PID-file value authorizes a signal. A lookup failure while the port remains occupied returns failure instead of spawning a replacement.

The full Bun run also exposed an existing test fixture defect. Its silent TCP server crashed on `ECONNRESET` during the version probe. The fixture now handles socket errors so daemon-stop is tested against a listener that remains alive until it is signaled. The unrelated `127.0.0.2` listener test is skipped on this macOS host because an actual bind probe rejects that address.

## Verification

Targeted regressions passed under Bun and Node. Before repair, Session regressions reported 1 pass / 12 fail and attach regressions 0 pass / 6 fail. Independent review reproduced B13 with 1 pass / 3 fail, then the same four live TUI cases passed after repair. The final root `bun test` run passed 190 tests with 55 skipped and no failures. `bun run test:node` passed 124 tests with 56 skipped and no failures. The build passed. The Bun-only CLI suite is excluded from Node by the existing Vitest configuration; the new lifecycle and attach suites exercise both relay runtimes. The attach TUI itself runs under Bun in both suites.

Final independent review re-ran the listener and paste failures under the repaired source. It confirmed that the unrelated IPv6 listener and stale-PID process survived, restricted-PATH shutdown succeeded, and paste retained the expected bytes. Three earlier independent reviewers also exercised the lock with real concurrent processes; those finite stress runs found no overlapping critical sections. Logs remain in the local `.audit` directory.

The feature-map checker found all 24 CLI registrations, 37 public Session members and 14 root exports, and validated 270 local links. The Relay model reached 22 states and 49 steps; all seven configured checks including deadlock detection passed. Three deliberate model mutations were rejected by their intended invariants. The updated Pele SVG was rendered and inspected with a white background.

Fix Root Causes guided the lock, subscription and input-lifetime repairs. Prove It Works required each reported defect to have runtime evidence before repair and a corresponding passing replay. Separate Before Serializing Shared State kept implementation and review workers in distinct checkouts and test ports.

## Limits

The lifecycle lock requires coherent enumeration of the local contender directory. Node's API does not promise an atomic directory snapshot. Runtime contention tests are evidence, not a filesystem proof or exhaustive interleaving proof. PID reuse can conservatively block recovery rather than evict a possibly live owner. The shared directory must not be removed while clients use it.

Old lifecycle binaries do not participate in the new lock. Ordinary old clients still reuse a healthy newer daemon. A detached child spawned just before its parent crashes can bind later. Port enumeration followed by numeric PID signaling is not an OS-stable process handle. Windows signals force termination. Windows and Linux process discovery were checked with parser fixtures but were not executed on those operating systems in this macOS audit.

Protocol2 fixes data/control ambiguity for upgraded clients. Legacy clients retain their old ambiguity. Paste contents are forwarded, but child bracketed-paste mode negotiation is not added. Native terminal cell geometry follows the installed Ghostty engine.

The updated [starter models and white-background Pele diagrams](statecharts.md) remain bounded abstractions. The Relay chart now includes lock reacquisition after waiting and checks lock release on completed operations; it does not model the bakery algorithm or prove implementation correctness.
