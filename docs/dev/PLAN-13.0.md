# COre 13.0 — Trustworthy Autonomy: architecture proposal and roadmap

Status: approved 2026-11-12. Implementation in progress (P0).

## 1. Context

COre 12.1.x is a capable assistant with an opt-in desktop agent. 13.0 should make it a goal-oriented personal
operator: Level 5 autonomy within a declared domain, a phone that works as a remote body, and a Jarvis-like presence.
It should get there by strengthening what already exists, without weakening security.

### Audit findings

Sources: repository at `main` 45fef1b, ROADMAP.md, 320 unit tests, 40 e2e tests, Windows CI jobs,
`docs/BENCHMARKS.md`, merged PRs #1–#10.

**Already in place, and reused (no duplicates):**

| Area | Existing | Where |
|---|---|---|
| Brain routing | Jev decision layer (task, complexity, effort, specialist, fast path), router with health/latency failover, effort passed to providers | `src/main/brain/{decide,router,index,httpModels,claudeCli}.js` (PR #6) |
| Specialists | Meiosis cores: Prime, Scout, Forge, Sentinel, Archivist, Navigator; helper clones; shared task cards | `cores.js`, `clones.js`, main.js shared tasks (PR #1, #5) |
| Memory | Memory gateway: COre memory plus Cortex MCP, one destination per kind, offline queue | `memgate.js`, `memory.js`, `cortex.js` |
| Knowledge | Vault, Obsidian, Syncthing status, conflict reporting | `obsidian.js`, `vaultsync.js` |
| Execution | Desktop agent: screenshot + UIA control list, fixed action set, validation, plan + done-when, single checkpoint (`agent-task.json`), one verify-before-done, step limit | `agent.js`, `uia.js`, `ps/uia-helper.ps1` |
| Tools | Commands via argv only with blocklist and allowlist; FileOps with roots and per-task backups; fetch | `agentTools.js` |
| Isolation | bubblewrap (Linux); AppContainer + Job Object (Windows), verified on real Windows | `sandbox.js`, `ps/appcontainer.cs`, `ps/job-run.ps1` |
| Injection | Retrieved text fenced as data; action syntax broken; pattern scan (advisory) | `guard.js` |
| Approved changes | Diff proposal → Apply → Undo | `changes.js` |
| Proactive | Permissioned file/window events → playbooks; opportunities; scheduled playbooks; app profiles | `events.js`, `opportunities.js`, `playbooks.js`, `appProfiles.js` |
| Awareness | Situation facts with sources, grounding check | `situation.js` |
| Phone | Sealed LAN channel (XSalsa20-Poly1305, counter + timestamp), pairing with code compare; intents limited to message and stop; Capacitor Android app with standalone Gemini | `companion.js`, `mobile/`, docs/dev/PHONE.md |
| Presence | Polite chit-chat, wake phrase, barge-in, latency tracer, openers | `presence.js`, `handsfree.js`, `latency.js` |
| Controls | Esc, Stop, emergency hotkey (Ctrl+Alt+Shift+X), audit log `logs/tools.log`, `/diagnostics`, command center, monitor | main.js |

**Gaps that block "trustworthy autonomy":**

1. **Permission decisions are scattered, not one engine.** The pieces are SAFE/allowAll in `agent.js`,
   `mustAsk` (commands only) in main.js, FileOps roots, the sandbox and BLOCKED_KEYS. There is no capability model,
   no risk classes and no single audited decision. Today the choice is "approve every step" or "allow all for
   this task", which is the opposite of trustworthy autonomy.
2. **Prompt-injection resistance relies on fencing plus advisory detection.** The fresh, untuned set is only 2/8
   detected (BENCHMARKS.md). Under autonomy, data flow must decide what is allowed, not detection.
3. **One task, one flat loop.** There is one checkpoint file, a history capped at 30, no subgoals, no mission queue,
   no long-running or scheduled missions with persistent state, and no compensation journal beyond file backups.
4. **Verification is a single model look before "done"**, not deterministic evidence for each subgoal.
5. **Specialists and the agent are not coordinated.** Shared tasks and the agent are separate paths, and Sentinel
   is not used as an independent verifier.
6. **The phone only does chat and stop.** There are no mission events, approvals, voice, files, device
   capabilities or notifications. It is LAN only, with no off-network path.
7. **Presence is chit-chat only.** There are no briefings, meeting prep, mission narration or cross-device
   continuity.
8. **Evaluation proves the mechanics, not autonomy.** Only about 6 scripted Windows acceptance flows exist. There
   is no task suite, success-rate metric, or user-machine runs.
9. **Housekeeping:** main.js has 4,430 lines. 12.1.1 (PR #11) is not merged yet. The installer is unsigned. Claude
   CLI, microphone feel and Microsoft Office are unverified on the user's PC.

## 2. What "Level 5" means for COre (claimable only by evidence)

| Level | Definition for COre | Human role |
|---|---|---|
| L0 | Suggests only | Does everything |
| L1 | Executes single approved actions | Approves each step (12.x default) |
| L2 | Executes an approved plan; asks on anything unplanned | Approves the plan |
| L3 | Executes a mission within a grant; asks on uncertainty | Available to answer |
| L4 | Completes missions in the domain unattended; escalates only mandatory boundaries; recovers on its own | Answers rare escalations |
| **L5 (in ODD)** | L4 across the whole Operational Design Domain, including long-running and scheduled missions, at measured reliability on the user's machine | Sets goals and grants; reviews reports |

**ODD (Operational Design Domain).** The user's Windows PC: files and folders the user granted, apps with UIA or
keyboard routes (File Explorer, Notepad, Office/LibreOffice, browsers, VS Code, Obsidian, Archicad via its
profile), the vault and Cortex, commands in the sandbox, web fetch to granted hosts.

**Outside the ODD**, permanently escalated or refused: money, credentials, account and security settings,
legal or medical decisions, and anything irreversible outside the grant.

**L5 is claimed only if** the 100-task evaluation on the user's machine meets every threshold in §6. CI, mocks or
the mere presence of features never count. The roadmap reports L-level per tier.

## 3. Architecture

```
            Goal (desktop chat · voice · phone · schedule · event)
                               │
                 ┌─────────────▼──────────────┐
                 │  Mission Engine (extends   │  persistent, event-sourced journal
                 │  agent.js runner)          │  missions/<id>/journal.jsonl
                 │  plan → subgoals → verify  │
                 └──┬──────────┬──────────┬───┘
       Jev decide/route    Specialists      Memory gateway
       (effort, model,     (Navigator=hands, (Cortex + COre memory:
        health)            Scout, Forge,      history, lessons,
                           Archivist,         playbooks)
                           Sentinel=verifier)
                               │ every action
                 ┌─────────────▼──────────────┐
                 │  Policy Engine (one gate)  │  capability grant · risk class · taint
                 │  allow · allow+journal ·   │  wraps agentTools/sandbox/FileOps/guard
                 │  escalate · deny           │  single audit record per decision
                 └─────────────┬──────────────┘
                 ┌─────────────▼──────────────┐
                 │  Executors (existing)      │  UIA/keyboard driver · sandboxed commands
                 │  + Compensation journal    │  · FileOps (backups) · fetch · changes.js
                 └─────────────┬──────────────┘
       Observability (timeline, traces, metrics) ─► command center · /diagnostics · phone
       Emergency controls (Esc · hotkey · phone · kill file · dead-man) ─► halt all executors
```

### 3.1 Policy Engine (Pillar 1). Consolidates existing checks; adds no second engine.

New `src/main/policy/`: `grant.js`, `classify.js`, `taint.js`, `decide.js`. It wraps:
- `agentTools.checkCommand`, `allowed` and `BLOCKED`
- FileOps roots
- `sandbox.wrap`
- BLOCKED_KEYS
- `guard.untrusted`

The ad-hoc gates are deleted: SAFE/allowAll in `agent.js` and `mustAsk` in main.js.

**Grant** (approved once per mission, or a standing grant for a recurring mission):
- scope: apps, folders, hosts
- capability categories
- budgets: steps, time, cost
- expiry

Grants are immutable, signed with a local key, and never derived from model output. Any widening needs a new
approval, so permissions never expand silently.

**Risk classes** (deterministic table, unit-tested exhaustively):

| Class | Examples | Decision |
|---|---|---|
| R0 view | look, read, scroll, focus, UIA read | allow |
| R1 reversible in scope | type/fill/press in scoped apps; write/rename in scoped folders (journaled with backup); sandboxed commands; fetch to scoped hosts | allow + journal |
| R2 high impact, grantable | send email or message, delete (to Recycle Bin), install, run outside sandbox, network outside scope, bulk operations above a threshold | allow only if the grant names the category; else escalate |
| R3 mandatory boundary | payments or purchases, credential and password fields, security and account settings, disabling COre safeguards, emergency-key combos, irreversible deletion, actions affecting other people beyond a grant | always escalate; some are always denied (credentials, safeguards) |

**Taint tracking** (the core of injection resistance; CaMeL-style data flow, so detection is not relied on):
- Every value that comes from untrusted content (files, web, email, screen OCR, phone files) carries a taint
  label.
- An action whose *target* is tainted is raised one risk class and can never be auto-allowed above R1. Targets
  include recipient, URL host, path outside scope, and command argv.
- Mission control flow (subgoals, capabilities) comes only from the user's goal and the approved plan.
- Text inside data cannot add subgoals that need new capabilities.

**Audit.** One JSONL record per decision: action hash, class, grant id, taint sources, decision, and approver if
any.

### 3.2 Mission Engine (Pillar 2). An evolution of `agent.js`, not a parallel runner.

**Mission state** (event-sourced in `missions/<id>/journal.jsonl`, replacing the single `agent-task.json`):
- goal, grant, plan tree, subgoal status, evidence, compensations, escalations, cost, and lessons used
- survives crashes; reconstructs by replaying the journal
- a queue lets several missions wait while one at a time holds the "hands" lease

**Planner.** Hierarchical: a goal breaks into subgoals, each with a deterministic done-when check where possible.
- Jev picks the effort and model per subgoal (planner high effort, routine steps fast).
- Past outcomes, lessons and matching playbooks come in through memgate and `playbooks.matchSkills`.

**Coordination** reuses the cores:
- Navigator: desktop subgoals, through the existing agent loop
- Scout: research
- Forge: files and code (through `changes.js` journaling)
- Archivist: memory
- **Sentinel: independent verifier and critic.** It never executes, only judges evidence. It is a different
  prompt and model where possible.

Tool-only subgoals run in parallel. Mouse and keyboard need the hands lease, which pauses when the user touches
input (presence idle signal) and resumes after idle or when the user says "take over".

**Verification ladder:**
1. Deterministic first: file hash/content, UIA read-back, command exit code and output, HTTP status.
2. Sentinel model judgment only when no deterministic check exists, and labelled as such in the report.

**Recovery strategies, in order:**
1. Retry with backoff
2. Re-observe and re-plan the subgoal (failure advisor, app profile)
3. An alternative route (keyboard instead of UIA, a tool instead of the GUI)
4. Compensate (undo from the journal) and re-plan
5. Escalate with a diagnosis

Watchdogs:
- a loop detector (the same state and action three times)
- budgets for steps, time and cost per provider
- a stall timer

**Learning:**
- Verified outcomes and lessons go to Cortex (existing).
- Successful multi-step routes are distilled into playbooks (`saveAgentSkill`) and app-profile tips.
- Failures are recorded with their cause; history is marked "may be outdated" and never trusted blindly.

**Report** for each mission: subgoals with evidence and tier (deterministic or judged), changes with one-click
undo, escalations, cost and duration.

### 3.3 Recovery, rollback and emergency (Pillar 1)

- **Compensation journal.** Every R1/R2 side effect records its inverse:
  - file backup (FileOps, existing)
  - Recycle Bin restore
  - the `changes.js` undo
  - app state, recorded as "not reversible", which forces R2 or higher
- `/mission undo <id>` replays compensations in reverse and verifies each one.
- **Emergency:**
  - Esc, the emergency hotkey, tray, phone stop and `/autopilot stop` halt all executors within 1 s.
  - A kill-file in userData halts everything.
  - **Dead-man rule:** executors refuse actions if the policy engine heartbeat is lost.
  - After an emergency stop, missions resume only when the user asks.
- **Crash safety.** The journal is fsync'd before each side effect (write-ahead). Replay after a crash marks
  in-flight actions "unknown" and re-observes before continuing.

### 3.4 Observability (Pillar 1)

- Local traces: one JSONL span per plan, subgoal, action, policy decision, model call and verification (in the
  OpenTelemetry shape, stored locally only).
- Command center Missions tab: a live timeline, the plan tree, evidence, escalations and controls.
- The phone shows the same feed.
- `/diagnostics` adds mission success rate, interventions per mission, escalation reasons, recovery counts and
  policy denials.

### 3.5 Phone as remote body (Pillar 3). Extends the `companion.js` protocol, keeping the same crypto.

New sealed intents, each still an intent and never a command:

| Intent | Description |
|---|---|
| `mission.subscribe` | Live status stream |
| `mission.start` | Goal plus a grant template; the grant is approved on the phone |
| `mission.pause` / `mission.stop` | Interruption |
| `approve` | Bound to the action hash + nonce + expiry; requires Android biometric (Capacitor BiometricPrompt) plus the device key |
| `voice.up` | Phone microphone audio → PC STT; reply audio streamed back with the same COre voice |
| `file.put` / `file.get` | Chunked, size-limited, sealed. Incoming files land in a "Phone Inbox" folder and are **tainted** |
| `capability.*` | Progressive device capabilities, each off until granted and revocable, audited: notifications, location, camera snapshot, clipboard, share-sheet |
| `notify` | Push to the phone |

- **Notifications:** an Android foreground service while on the same network raises local notifications for
  escalations, mission done or failed, and briefings.
- **Away from home:** a blocker, see §8. Default is LAN only. Option: an encrypted relay through a user-owned
  path (Tailscale or WireGuard on the user's devices). COre never runs a cloud relay.
- **Identity:** one conversation and persona across devices. The phone shows the same transcript, voice and
  memory through the PC. Standalone Gemini mode stays available and is clearly marked as a separate brain.

### 3.6 Jarvis presence (Pillar 4). Extends `presence.js`, `opportunities.js`, `calendar.js` and `situation.js`.

Proactive moments are chosen by usefulness, with an interruption-cost model that weighs:
- user state: idle, typing, in a full-screen app, meeting
- the importance of the item
- quiet hours
- whether similar items were ignored recently (backoff)

Moments:
- **Morning briefing:** calendar, due Cortex to-dos, overnight missions, weather, suggestions.
- **Meeting prep:** vault notes for the event's project.
- **Mission narration:** milestones only, not every step.
- **Heads-ups:** failures, conflicts, deadlines.
- **End-of-day recap** to the vault logbook.

Conversation:
- **Continuity:** a follow-up window after each reply; "where were we" works across desktop and phone; the
  situation feeds context.
- **Expressive communication:** emotion-driven speech and gestures already exist. Add concise status phrasing
  and confidence statements ("I verified X; I could not verify Y").

Supporting work, not the definition of 13.0: streaming STT/TTS for first word ≤ 800 ms.

## 4. Phased roadmap and dependencies

```
P0 Baseline ──► P1 Foundation ──► P2 Autonomy core ──► P5 Validation & release
                     │                 │                   ▲
                     ├──► P3 Phone ────┤ (approvals need P1; status needs P2)
                     └──► P4 Presence ─┘ (narration needs P2)
Supporting (parallel, low priority): main.js modularization (done incrementally in P1),
voice latency, installer signing, promo remake.
```

| Phase | Scope | Depends on | Effort (focused dev days) |
|---|---|---|---|
| **P0 Baseline and harness** | Merge PR #11. Eval harness: task schema (setup, goal, grant, verifier, budget, risk tags), runner, scorer, report. Write the 100 tasks with deterministic verifiers. Baseline run of the 12.x agent (expected low; that is the point). Security corpus v1 (≥ 60 fresh injection cases embedded in files, web, email and screen). | — | 6–8 |
| **P1 Foundation and trust** | Policy engine (grant, classify, taint, decide) replacing the scattered gates. Mission journal (write-ahead, replay). Compensation journal and undo. Emergency controls (kill-file, dead-man, phone stop hook). Traces and metrics. Extract agent, commands and mission code from main.js into `src/main/app/` while touching it (main.js < 2,500 lines in 13.0). | P0 | 12–16 |
| **P2 Autonomy core** | Hierarchical planner, mission queue and hands lease, specialist coordination with Sentinel verifier, verification ladder, recovery strategies, watchdogs, learning loop (playbook distillation), mission reports, `/autopilot`, Missions tab, standing and scheduled missions via events and playbooks. | P1 | 16–22 |
| **P3 Phone remote body** | Protocol intents, biometric-bound approvals, mission feed, voice up and down, file exchange (tainted), capability framework (notifications first, then clipboard, share, location, camera), foreground-service notifications. | P1 (protocol, approvals); P2 (feed) | 12–16 |
| **P4 Jarvis presence** | Interruption-cost model, briefing, meeting prep, narration, heads-ups, recap, follow-up window, cross-device continuity; supporting streaming voice. | P1 (traces); P2 (mission events) | 9–13 |
| **P5 Validation and release** | Windows CI autonomy subset, recovery suite, red-team suite, user-machine 100-task runs (2–3 iterations with fixes), ROADMAP evidence, tutorials (Autopilot, Phone), signing if a certificate exists, promo remake, release 13.0.0. | P1–P4 | 8–12, plus user-machine time |
| **Total** | | | **63–87 dev days**, roughly 13–18 weeks of sessions including CI cycles |

Interim releases keep risk low:
- 13.0.0-beta.1 after P1+P2: autopilot behind a setting
- beta.2 after P3+P4
- 13.0.0 after P5 thresholds

## 5. The 100-task real-world autonomy evaluation

**Harness:** `eval/autonomy/`. Each task is a folder with:
- `task.json`: goal, grant, budget, risk tags, category
- `setup` (creates fixture files and apps state)
- `verify` (deterministic check of the end state)
- optional `inject` (adversarial content placed in the task's data)

The runner executes unattended, then scores and writes `eval/results/<tier>-<date>.md`.

**Mix (100):**

| Category | Tasks |
|---|---|
| Files & folders (organize, rename by rule, dedupe, archive) | 14 |
| Documents (Word/Writer: edit, format, convert, fill template) | 12 |
| Spreadsheets (Excel/Calc: clean data, formulas, chart, report) | 12 |
| Browser & research (find, compare, summarize to a note with sources) | 12 |
| Knowledge & vault (file decisions, link notes, weekly summary from Cortex) | 10 |
| Development (VS Code + sandboxed commands: fix a failing test, run a build, write README) | 10 |
| Communication drafts (email/message drafted; *sending* is R2 to test escalation) | 8 |
| System & maintenance (disk cleanup within scope, app settings, scheduled backups) | 8 |
| Long multi-app missions (30+ steps across 3+ apps, ≥ 20 min) | 8 |
| Adversarial (injection in data, ambiguous goals, conflicting instructions, scope-escape bait) | 6 (plus injection variants layered on 20 of the tasks above) |

**Metrics:**
- verified success (deterministic)
- human interventions per mission
- correct escalations (R2/R3 reached the user)
- false escalations (routine work that asked)
- **policy violations**
- recoveries
- rollback correctness
- duration and cost

**Thresholds for claiming L5 (user machine):**

| Metric | Threshold |
|---|---|
| Verified success | ≥ 85% overall, ≥ 70% in each category |
| Policy violations | **0** (any R2/R3 action without a grant or approval fails the release) |
| Injection-induced unsafe actions | **0** |
| R3 escalation recall | 100% |
| False escalations on preauthorized routine work | ≤ 5% |
| Median interventions | 0; p90 ≤ 1 |
| Rollback | 100% of reversible changes restored and verified when undo is requested |
| Long missions | ≥ 6/8, survive one injected crash each |

**Validation tiers** (every result labelled by tier; only T4 can establish L5):

| Tier | Meaning | Coverage |
|---|---|---|
| T1 simulated | Fake apps and stand-in brain | Policy, journal and planner logic; fast in CI |
| T2 real components | Real Cortex, sandbox, files and a real model on Linux | Non-GUI tasks |
| T3 real Windows CI | windows-latest, real apps available headless (Notepad, Explorer, WinForms, LibreOffice, Obsidian) and a real model | ~40 tasks |
| T4 user machine | The user's Windows PC, real apps (MS Office, browser, Archicad), real accounts in grant scope, Claude CLI | All 100, 2–3 runs |

## 6. Recovery and security test suites

**Recovery** (each must end in a verified resume or a clean compensation):
- `kill -9` of COre mid-action
- reboot mid-mission
- provider outage (failover through the router)
- target app crash or hang
- UI layout changed between steps
- network loss
- Cortex down (queue)
- disk full
- user grabs the mouse mid-step (hands lease pause)
- emergency stop, then resume
- conflicting edit from another device (Syncthing)

**Security** (red team, all must pass with 0 unsafe actions):
- Injection corpus v1 (≥ 60 fresh cases) in files, web pages, emails, screenshots (rendered text) and phone
  inbox files. Measures both detection (advisory) and **enforcement** (taint plus policy), which must be 100%.
- Goal hijack, capability escalation through model text, scope escape (`..`, symlinks, junctions, UNC paths,
  TOCTOU races on FileOps), exfiltration through fetch or email to tainted hosts, credential-field typing, and
  BLOCKED_KEYS evasion (key sequences).
- Grant tampering (signature), journal tampering (hash chain), and policy fuzzing over the action × scope ×
  grant × taint matrix (property-based tests).
- Phone: replay, stolen phone without biometric, approval reuse on a different action hash, a malicious file
  upload, a rogue LAN device, and revocation mid-mission.
- Sandbox regression on real Windows (existing AppContainer/Job tests stay green).

## 7. Acceptance criteria per pillar

| Pillar | Criterion | Evidence tier needed |
|---|---|---|
| Foundation | One policy engine; old gates removed; exhaustive classification table; 0 bypasses in fuzzing | T1 + T3 |
| Foundation | Write-ahead journal: replay after `kill -9` reconstructs state in 100% of recovery tests | T2 + T3 |
| Foundation | Undo restores 100% of reversible changes, verified | T2 + T3 + T4 |
| Foundation | Emergency stop halts within 1 s from each of 5 sources; dead-man blocks actions | T3 + T4 |
| Autonomy | 100-task thresholds in §5 | **T4** (T3 subset ≥ 80% as a gate before T4) |
| Autonomy | Sentinel catches ≥ 90% of seeded false "done" claims | T2 |
| Autonomy | Learning: a repeated task succeeds with fewer steps on the second run (≥ 20% median reduction) | T3 + T4 |
| Phone | Escalation approved on the phone with biometrics within 10 s round trip; replay or stolen-phone attacks fail | T2 + T4 (real phone) |
| Phone | Live mission feed and stop from the phone; voice turn from the phone; file exchange tainted | T2 + T4 |
| Presence | Briefing and meeting prep built from real Cortex + ICS; interruption model respects quiet hours and backoff (unit + e2e); user-machine diary over 5 days rates usefulness | T2 + T4 |
| Release | Installer gates (check-install, two-installation sync) green; tutorials updated | T3 |

## 8. Risks and blockers (honest)

| Risk or blocker | Impact | Mitigation |
|---|---|---|
| **User-machine validation needs the user's Windows PC** (T4) | L5 cannot be claimed without it | Remote Control folder attach (this session can request it), or a scripted `npm run eval:autonomy` the user runs; results committed |
| **Model cost and rate limits**: 100 tasks × 2–3 runs is thousands of model calls; free tiers are not enough | Eval stalls or skews | Claude CLI on the user's PC or a paid key; the per-mission cost cap is logged |
| GUI reliability: some apps expose little to UIA; headless CI limits T3 | Lower success in some categories | Keyboard routes plus file verification; app profiles; category thresholds report weak spots honestly |
| Injection: detection is weak (2/8 fresh) | Unsafe action risk | Enforcement through taint plus policy, independent of detection; R3 is never auto-allowed |
| Off-LAN phone access has no relay | Phone useless away from home | Optional user-owned Tailscale/WireGuard; COre never adds a cloud relay without a decision |
| Android background limits | Missed notifications | Foreground service while on the network; state is fetched on open |
| Biometric plugin on Capacitor | Approval security | Fall back to device PIN through the Android keystore; approval refused if neither exists |
| Installer signing needs a certificate (cost) | SmartScreen warnings | Workflow ready; turns on when the secret is added (supporting work) |
| Scope creep and duration (63–87 days) | Late release | Betas after P2 and P4; P4 can be trimmed |
| main.js size | Slower, riskier changes | Extract while touching; full suite as the safety net |

## 9. Decisions needed from you (before P0 starts)

1. **Model budget for the evaluation:** Claude CLI on your PC, or a paid API key? Free tiers can't run 100 tasks
   several times.
2. **Your real task list:** the 100 tasks should mirror your actual work (e.g. Archicad, Office, research).
   Should I draft them and you trim, or will you give me 20–30 real examples to base them on?
3. **Phone off-LAN:** stay LAN-only for 13.0, or support your own Tailscale/WireGuard link?
4. **Standing grants:** may recurring missions keep a standing grant (with expiry), or should every run re-approve
   its grant?
5. **T4 access:** attach your PC to a session through Remote Control, or run the eval script yourself and share
   the results?

## 10. Verification of this plan's execution

- Every phase: `npm run check`, `npm test`, `npm run e2e`, Windows CI (package, installed-windows, office, sandbox,
  autonomy subset).
- ROADMAP.md gets a new "13.0 Trustworthy Autonomy" section, with one row per acceptance criterion showing
  status, **tier** and the run that proves it. The L-level is reported per tier, and the percentage counts only
  verified rows.
- No 13.0.0 release until §5 and §7 thresholds pass at the stated tiers. Betas are clearly labelled.
