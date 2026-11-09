# Pending approval queue

Each milestone is committed locally on `dev/core-next` and is **not pushed**. Approve by replying
`APPROVE PUSH M-00x`. That pushes exactly the listed commit range to `review/core-M-00x`, never to `main`.
Approval to push is not approval to merge, and approval to merge is not approval to release.

| Milestone | Commit | Depends on | Status |
|---|---|---|---|
| M-001 Gated release engineering | `a083070` | `b84d355` (main) | AWAITING USER APPROVAL |
| M-002 Data safety and update recovery | `5d059a2` | M-001 | AWAITING USER APPROVAL |
| M-003 Calendar correctness, credential protection, visible errors | `9462f35` | M-002 | AWAITING USER APPROVAL |
| M-004 Brain reliability (watchdogs, partial recovery, health) | (see `git log`) | M-003 | AWAITING USER APPROVAL |

## Decisions needed (not code)
- The published releases v2.0.0 – v10.2.0 are broken (missing installer or blockmap, no `latest.yml`).
  Options: delete them, or mark them as pre-release, before the first gated release is published. I will
  not touch them without explicit approval.
