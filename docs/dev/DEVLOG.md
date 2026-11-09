# Development log

Local development on branch `dev/core-next`, based on `main` @ `b84d355` (v10.3.0).
Nothing is pushed without explicit approval. See APPROVALS.md for the queue.

## 2026-11-09

- **Phase 0 audit:** docs/dev/AUDIT-2026-11-09.md. Critical: every release build failed (racing double
  publisher), releases are missing files and `latest.yml`, publishing was triggered by version bumps
  without gates, and `publisherName` was set on unsigned builds. High: corrupt data files overwritten,
  source updater with no rollback following `main`, Windows CLI tests skipped.
- **M-001** (`a083070`): gated release engineering, CI, smoke-test mode, installer test script.
- **M-002** (`5d059a2`): quarantine of corrupt data files, release-channel source updates, backup/rollback,
  crash-loop rollback with the `boot.js` bootstrap.
- **M-003** (`9462f35`): calendar time zones and recurrence, encrypted calendar link, visible main-process errors.
- **M-004** (`89c610d`): brain watchdogs, partial-answer recovery with Continue, provider health, history size budget, Ollama keep_alive.
- **M-005** (`e2b60e7`): memory slots and contradiction handling (conservative), project facts, provenance, inline editing.
- **M-006** (`f7697d4`): Meiosis Mode: core identities, unified attributed timeline, @mention routing with autocomplete and picker, role-based specialist sessions, shared tasks with a Prime summary, subtitle attribution.
- **M-007** (`aa83af0`): interrupted-task recovery, /stop and /merge per core, the summary waits for specialists to finish speaking (found with real Claude + voice), CORE_DEBUG voice timing.
- **M-008** (`6e6d0d7`): chat redesign at the user's request: bubble chat with orb avatars, rotating core wheel, orb-pill @ autocomplete; fixed the wheel turning back when an orb slid under a resting pointer.
- **M-009** (`e343244`): read-only project tools (list/read/find), realpath containment, secret refusal, caps, audit log, specialist tool rounds, Settings → Projects folder picker. Validated with real Claude: Forge searched, Prime read, .env refused.
- **M-010** (`937aff2`): approved file changes: file= fenced proposals, diff card, Apply with stale-file refusal, backup, atomic write, Undo, audit. Validated with real Claude (Forge read, proposed, applied, undone).
- **M-011** (`61b8af6`): research doc (Archicad JSON API, pyRevit Routes, Windows UIA, Android pairing design) + read-only Archicad skill (localhost, allowlisted read commands, off by default), tested with a mock API only.
- **M-012:** at the user's request: minimal flat chat (no glass), brand fonts bundled (OFL) and applied to chat/settings/history/subtitles, brand palette; fixed uppercase "CORE" (the brand rule says always COre).
- **M-013** (`4873823`): measured CPU/GPU reductions (safe graphics idle 173% → 37%), light render path, profile retune, latency instrumentation.
- **M-014:** at the user's request: floating-bubble chat. Every element is a separate bubble on a transparent window; clicks pass through the gaps (Windows/macOS, `setIgnoreMouseEvents` with forward); settings overflow fixed.
- **M-015:** at the user's request (reference image): one clear panel with a solid frame, header with mark and status, grouped Smoke bubbles, filled input pill, card-based quick settings; notes are halo text, not pills; brand audit of the overlay caption, History panel and Settings window.
- **M-016:** glance card beside the orb (now playing, synced lyrics via LRCLIB, short cards via `[[do glance ...]]`), media session read only while open (Windows GSMTC long-lived reader, Linux playerctl), instant local answers for short requests (measured 43–199 ms). Windows media reading is untested on real Windows.
