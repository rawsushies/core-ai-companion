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
| M-011 Phase 5/6 research + read-only Archicad PoC | (see `git log`) | M-010 | AWAITING USER APPROVAL |

## Decisions needed (not code)
- The published releases v2.0.0 – v10.2.0 are broken (missing installer or blockmap, no `latest.yml`).
  Options: delete them, or mark them as pre-release, before the first gated release is published. I will
  not touch them without explicit approval.
