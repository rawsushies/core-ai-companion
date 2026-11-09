# Pending approval queue

Each milestone is committed locally on `dev/core-next` and is **not pushed**. Approve by replying
`APPROVE PUSH M-00x`. That pushes exactly the listed commit range to `review/core-M-00x`, never to `main`.
Approval to push is not approval to merge, and approval to merge is not approval to release.

| Milestone | Commit | Depends on | Status |
|---|---|---|---|
| M-001 Gated release engineering | `a083070` | `b84d355` (main) | AWAITING USER APPROVAL |
| M-002 Data safety and update recovery | `5d059a2` | M-001 | AWAITING USER APPROVAL |
| M-003 Calendar correctness, credential protection, visible errors | `9462f35` | M-002 | AWAITING USER APPROVAL |
| M-004 Brain reliability (watchdogs, partial recovery, health) | `89c610d` | M-003 | AWAITING USER APPROVAL |
| M-005 Memory consistency, projects, provenance, editing | `e2b60e7` | M-004 | AWAITING USER APPROVAL |
| M-006 Meiosis Mode slices 1–5, 7 (cores, one chat, routing, role helpers, subtitles, shared tasks) | `f7697d4` | M-005 | AWAITING USER APPROVAL |
| M-007 Meiosis recovery, per-core stop/merge, voice-order fix, real-Claude validation | `aa83af0` | M-006 | AWAITING USER APPROVAL |
| M-008 Chat redesign: bubbles with orb avatars, rotating core wheel, orb-pill autocomplete | `6e6d0d7` | M-007 | AWAITING USER APPROVAL |
| M-009 Permissioned read-only project access (Phase 4 slice 1) | `e343244` | M-008 | AWAITING USER APPROVAL |
| M-010 Approved file changes with diff preview, Apply, Undo (Phase 4 slice 2) | `937aff2` | M-009 | AWAITING USER APPROVAL |
| M-011 Phase 5/6 research + read-only Archicad PoC | `61b8af6` | M-010 | AWAITING USER APPROVAL |
| M-012 Minimal branded UI: flat chat, bundled brand fonts, brand palette | `f13712d` | M-011 | PUSHED to review/core-M-012 (PR #1) |
| M-013 Measured CPU/GPU reductions, latency instrumentation | `4873823` | M-012 | PUSHED (user asked to push) |
| M-014 Floating bubbles with click-through gaps (superseded by M-015) | `a33d8bc` | M-013 | PUSHED |
| M-015 Chat redesign to the brand kit, brand audit across windows | `396e426` | M-014 | PUSHED |
| M-016 Glance card (now playing, lyrics, cards) + instant answers | `28821ea` | M-015 | PUSHED |
| M-017 Backups to a local or cloud-synced folder | `a8642a2` | M-016 | PUSHED |
| M-018 Phone companion (LAN, end-to-end encrypted) | `5eb4f49` | M-017 | PUSHED |
| M-019 No frames while hidden/locked, ambient and battery caps | `eb03f1b` | M-018 | PUSHED |
| M-020 Fewer particles while idle | `d8ce38a` | M-019 | PUSHED |
| (fix) Cloud-folder test on Windows | `7d32340` | M-020 | PUSHED, CI green on Linux + Windows |
| M-021 Cached quick-answer voice, no screenshots from the phone | `2b03131` | fix | PUSHED |

## Decisions needed (not code)
- The published releases v2.0.0 – v10.2.0 are broken (missing installer or blockmap, no `latest.yml`).
  Options: delete them, or mark them as pre-release, before the first gated release is published. I will
  not touch them without explicit approval.

## Combined request (all milestones are cumulative: each builds on the previous)

- Range: `b84d355..f13712d` on `dev/core-next` (plus this queue file), 12 milestones.
- Reply `APPROVE PUSH M-012` to push that exact range to `review/core-M-012`. Or approve a prefix, e.g.
  `APPROVE PUSH M-002`, to push only `b84d355..5d059a2`.
- After a push, CI (new `ci.yml`) runs Linux + Windows tests, the Windows packaged-app self-test and the
  installer install/uninstall test for the first time. Those Windows results are not known yet.

### Tests at f13712d
- `npm run check`: syntax OK (53 files). `npm test`: 164 passed, 0 failed, 0 skipped (Linux, Node 22).
- Real Electron (Linux, Xvfb): smoke test of the source and packaged apps; rollback (both paths); corrupt
  config; calendar secret; watchdog/Continue; memory edit; Meiosis routing, picker, wheel, autocomplete;
  shared tasks; voice order; interrupted-task recovery; project reads; propose/apply/undo; minimal UI and fonts.
- With the real Claude (logged-in CLI): expressive tags, Scout/Sentinel shared task, project reads, `.env`
  refusal, Forge proposal applied and undone.

### Not verified (honest)
- Anything on Windows: CI has not run yet (nothing pushed). That includes the `.cmd` Claude CLI path, the
  installer and its uninstall, the release updater (C3), music keys and app launching.
- The release workflow end to end (needs a tag, which needs your release approval).
- Archicad, Revit and UI Automation against the real applications. The Android companion is design only.
- On Linux without a keyring, Electron safeStorage falls back to `plain:` (a Windows/macOS keychain encrypts).

## Update after M-019
- Everything through M-019 is on `review/core-M-012` (draft PR #1) at the user's request. Nothing is merged,
  tagged or released. Approval to push is not approval to merge or release.
- CI on PR #1 passed on Linux and Windows (tests, packaged-app self-test, installer test) up to M-014; later
  runs are in progress.
- A stray branch `dev/core-next` was pushed by mistake and can't be deleted from this environment. It holds
  only commits already on the PR. Please delete it on GitHub.
- Tests at `2b03131`: `npm test` 190 passed, 0 failed. Follow-up audit: `docs/dev/AUDIT-FOLLOWUP.md`.

## PR #2 (improvement loop)
PR #1 was merged at the user's request (`d9044d6`). Loop work continues on `review/core-M-012` → PR #2:
M-022 `55f2ced`, loop-2 tests `bd3a20b`, M-023 `b39584c`, M-024 `6ce782c`, M-025 `8094ba5`, M-026 `addfa03`.
Not merged, tagged or released. The stray `dev/core-next` branch and the broken releases v2.0.0–v10.2.0 must be
deleted by the user: this session type can't delete branches or releases.
