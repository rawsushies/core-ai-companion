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
- **M-017:** backups to a local or cloud-synced folder (cloud folder detection, daily/weekly automatic backups with rotation, optional passphrase encryption, checksum, restore with pre-restore snapshot keeping local secrets). Verified end to end in the app with a fake Dropbox folder; restore covered by unit tests (its file dialog can't be driven here).
- **M-018:** phone companion: LAN-only, QR pairing with one-time secret and 6-digit comparison, per-device tweetnacl secretbox, counters + timestamps, revocation, encrypted key storage, brand-styled phone web app. Verified end to end with a phone browser profile; real phone and Windows firewall untested.
- **M-019:** render mode: paused while hidden/locked/suspended (measured 53% to 1.7% CPU in safe graphics), ambient 4 fps idle after 5 min away, battery caps (idle 10, active 30). Helpers follow the same mode.
- **M-020:** idle detail: a random half of the particles while idle (35% when away), eased back on activity; measured 51.6% to 45.5% CPU in safe graphics (6000 particles; full-screen passes dominate there).
- **M-021:** TTS phrase cache (short clips, bounded) and background pre-rendering of quick-answer lines (real model: about 300 ms to synthesise, 0 ms cached); phone messages never trigger screenshots; audit updated.
- **M-022 (loop 1):** P0 phone keys scrubbed from backups and kept on restore; P1 phone clock-skew retry loop fixed (server reports clock vs replay and its time; phone retries once); P2 whole chat panel takes the mouse; new real-app e2e suite (10 tests, about 19 s) added to CI.
- **M-023 (loop 2):** live cards: timer countdown (and on completion), weather card, calendar card; 'how long left' quick intent; unit + real-app tests.
- **M-024 (loop 3):** phone media remote (fixed keys, allowlisted op), lyrics card no longer a chatty live region.
- **M-025 (loop 4):** album art (Windows thumbnail stream, Linux MPRIS artUrl via file/https, capped, data: URL; overlay CSP allows data: images only); fake playerctl fixture; real-app test of the song card; last e2e test made robust to chat trimming. Windows art reading untested on real Windows.
