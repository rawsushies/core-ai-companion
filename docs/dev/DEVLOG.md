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
- **M-004:** brain watchdogs, partial-answer recovery with Continue, provider health, history size budget, Ollama keep_alive.
