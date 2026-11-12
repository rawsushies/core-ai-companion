# COre roadmap and status

Evidence-based tracker for the master roadmap. A requirement counts only when
its acceptance test passes against real components (real Cortex, real Windows
apps, real providers). Mocked tests are listed separately and never count as
real-world validation.

The earlier roadmap (versions 1 to 10) is kept in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md).

**Overall estimated completion: 93%** (planning baseline 38%; recalculated from
verified acceptance criteria below, last update 2026-11-12; unchanged by the 12.1 audit, which verified items already counted as pending work in the knowledge layer: 5 of 6 criteria verified, typing inside Obsidian untested).

## 13.0 Trustworthy Autonomy (in progress)

Plan: [docs/dev/PLAN-13.0.md](docs/dev/PLAN-13.0.md) (approved 2026-11-12). Four pillars: foundation & trust, Level 5
autonomy within a declared domain, phone as remote body, Jarvis presence. Every row states the **tier** of its
evidence: T1 simulated · T2 real components on Linux · T3 real Windows CI · T4 the user's own Windows machine.
Level 5 is claimed only from a T4 run of the 100-task evaluation meeting every threshold; nothing else counts.

**Autonomy level today: L1–L2** (12.x agent: approval per changing step, or one approval for a plan). Not yet measured
against the 100-task suite beyond the sample below.

| Phase | Criterion | Status | Tier | Evidence |
|---|---|---|---|---|
| P0 | 100-task suite (planned mix) + 20 injected variants; every reference solution passes, doing nothing fails | **Verified** | T1 | `test/eval.test.js`, `eval/autonomy/` |
| P0 | Injection corpus v1, 64 fresh cases (file, web, email, screen, phone), not used for tuning | **Done**; advisory guard flags **8/64 (12.5%)** | T1 | `eval/results/security-detection-v1.md` |
| P0 | Baseline of the 12.x agent on the suite | Sample only (free-tier model limits); full run needs the evaluation budget (decision 1 in the plan) | T2 | `eval/results/T2-baseline-12x-sample.md` |
| P1 | One policy engine (grant, risk class, taint) replaces the scattered gates | Not started | — | — |
| P1 | Write-ahead mission journal; replay after kill; compensation and undo | Not started | — | — |
| P1 | Emergency stop < 1 s from every source; dead-man | Not started | — | — |
| P2 | Mission engine, planner, Sentinel verification, recovery, learning | Not started | — | — |
| P3 | Phone: mission feed, biometric-bound approvals, voice, tainted files, capabilities | Not started | — | — |
| P4 | Presence: briefing, meeting prep, narration, heads-ups, continuity | Not started | — | — |
| P5 | 100-task thresholds at T4; recovery and red-team suites | Not started | — | — |

Blockers that only the user can clear: a model budget for the evaluation (free tiers rate-limit after a few tasks),
access to the user's Windows PC for T4, and the decisions in PLAN-13.0 §9.

## Memory architecture status

- **COre native memory** (`src/main/memory.js`) = active memory: profile,
  preferences, facts, confidence and decay, contradictions, task episodes.
- **Cortex** (`rawsushies/cortex-ai-brain`, MCP over stdio) = long-term
  knowledge: project decisions, lessons, linked notes, logbook, version history.
- **Memory gateway** (`src/main/memgate.js`) = the only memory interface the
  brain, specialists and agent use. One destination per kind (decision, lesson,
  knowledge, research go to Cortex; the rest stays native). No third engine.

## Knowledge layer (COre × Obsidian × Cortex × Syncthing)

COre ↔ memory gateway ↔ Obsidian-compatible Markdown vault (the one source of truth) ↔ Cortex (local index,
retrieval, history); Syncthing carries the vault between devices. Details: [docs/VAULT.md](docs/VAULT.md).
Evidence, by what it proves (only verified items count):

| Criterion | Status | Evidence |
|---|---|---|
| COre memory → Markdown note; outside edits indexed and recalled; two devices both ways; offline; conflicts keep both versions; fresh index reconnects | **Verified 8/8** (CI Linux, real Syncthing ×2, real Cortex ×2) | `test/vault.sync.test.js` |
| Cortex reports Syncthing conflict copies | **Verified** in Cortex (merged rawsushies/cortex-ai-brain#1) and in the vault test on CI | `tests/test_cloud.py` (Cortex), `test/vault.sync.test.js` step 7 |
| Real Obsidian opens the vault COre set up and shows its note | **Verified on Windows CI** (Obsidian 1.15.0, window "Tower - COre Vault - Obsidian") | `test/obsidian.win.test.js` |
| Installed app: first launch → bundled Cortex → vault → Obsidian list → remember and recall; second installation via Syncthing both ways | **Verified on Windows CI** (silent install of the real installer, two installations, Obsidian 1.15.0, real Syncthing; run 43201591563, 7/7 steps) and on a Linux package build | `test-e2e/installed.e2e.js` |
| Bundled Cortex.exe recognises Syncthing conflicts | **Verified on Windows CI** (installed Cortex.exe built reproducibly from cortex-ai-brain 87ca537 with pinned PyInstaller; brain_health reports the conflict copy; run 43201591563) | `scripts/ci/check-install.js` |
| Editing in the Obsidian app itself (typing a note) | Not tested: edits are simulated as file writes, which is how Obsidian saves | — |

## Cortex integration status

Connected through `src/main/cortex.js` (MCP client). The installer bundles Cortex.exe; a new install turns it on
at first start with a local vault (existing installs keep their choice; Settings, Privacy). History import stays off (`CORTEX_AUTO_IMPORT=off`);
Cortex's own consent gate (`import_history`) is never touched. COre never writes
vault files directly.

Obsidian: the vault is plain Markdown that Obsidian opens as-is (Cortex writes
atomically and re-indexes edits made in Obsidian). `/obsidian [note]` opens the
vault or a cited note through an `obsidian://` link (paths outside the vault refused;
`test/obsidian.test.js`). First start adds the vault to Obsidian's vault list; verified against the real
Obsidian on Windows CI (see the table above).

## Phase status

| Phase | Status | Estimate |
|---|---|---|
| 0 Memory integration | Done for 10/10 acceptance tests (real Cortex) | complete |
| 1 COre 2.1 desktop operator | Acceptance and security boundaries pass on real Windows CI; agent loop verified with a real model | ~95% |
| 2 COre 2.2 environmental intelligence | Acceptance on real Windows + real Cortex; a real model explains the desktop with no invented names | ~95% |
| 3 COre 2.3 proactive intelligence | Acceptance passes (unit with real Cortex + e2e); opportunity detection, approved maintenance, opt-in auto-resume | ~80% |
| 4 COre 3.0 unified experience | Combined acceptance in the real app and on real Windows; real-model validation 7/7 on Groq and on Gemini, live Jev 6/6; what remains needs the user's PC (Claude CLI, voice, presence) | ~85% |

### Phase 0: memory acceptance tests (real Cortex MCP, `test/memgate.test.js`, `test-e2e` "memory gateway")

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Preference across sessions | Pass | new Memory + new Cortex process recall it |
| 2 | Historical project decision from Cortex | Pass | decision recalled with `Projects/Tower.md` source |
| 3 | Combine active + long-term | Pass | `[Memory]` and `[Knowledge]` in one context |
| 4 | Contradictions preserved | Pass | native conflict log keeps the old fact |
| 5 | Update without destroying history | Pass | changed decision appended, earlier one kept (Cortex also versions notes) |
| 6 | Linked knowledge and sources | Pass | linked note arrives through Cortex link traversal; source paths kept |
| 7 | Corrupted index recovery | Pass | garbage `index.db` is set aside and rebuilt by Cortex |
| 8 | Cortex unavailable | Pass | native memory still answers; decision queued, delivered when back |
| 9 | No duplicate writes, clear ownership | Pass | duplicate decision refused; DESTINATION table |
| 10 | Import only with authorization | Pass | COre starts Cortex with auto-import off; retrieved notes fenced as data |

### Phase 1: COre 2.1 desktop operator

| Requirement | Status | Evidence |
|---|---|---|
| Windows UI Automation + accessibility tree | Verified on real Windows | CI windows-latest: WinForms edit/button/check box found, filled, pressed, toggled (UIA + Win32/MSAA fallback); real Notepad text area set and read back |
| Control-level actions (press, fill, expand, focus) | Verified on real Windows | `test/uia.win.test.js` |
| Planner (plan + done-when) | Verified | `test/agent.win.test.js` plan checkpointed and resumed |
| Multi-step task, interruption, resume, verified outcome | **Pass on real Windows** | `test/agent.win.test.js`: fill + press, Esc mid-task, resume from checkpoint, tick; result read back from the app (reasoning scripted: no provider in CI) |
| Windows process isolation | **Pass on real Windows** | Job Object (`test/sandbox.win.test.js`): tree kill on timeout incl. grandchildren, process cap, memory cap, no clipboard |
| Windows file-system + network isolation | **Pass on real Windows** | `COre.AgentSandbox` AppContainer: home folder read/write/list denied, other folders denied, loopback network denied, each compared with the same operation outside the box (CI windows-latest, 4da09ae). npm/npx/pnpm/yarn run under the Job only (Node child processes cannot start inside an AppContainer); the command note says so |
| Least privilege, approvals, e-stop, audit, rollback | Implemented | e2e emergency stop, tools + undo, plan approval |
| Timeouts, process-tree kill, retries | Verified | taskkill /T; Job kill-on-close; failure advisor |
| Memory gateway in planning and execution | Implemented | agent experience reads Cortex; lessons and outcomes written back |
| Model switch keeps context | Verified with stand-in providers | e2e failover with continuity |
| Real AI providers | **Verified with Groq (7/7), Gemini (7/7) and live Jev routing (6/6)** | [docs/REAL-PROVIDERS.md](docs/REAL-PROVIDERS.md): `npm run validate:providers` runs COre's production brain against the real model: model picked from the live list (`openai/gpt-oss-120b`), `reasoning_effort=high` accepted, answer from real Cortex knowledge citing `Projects/Tower.md`, failover from a dead provider keeping the conversation, injected instructions in a file not obeyed, desktop explained with no unsupported names, and the agent loop reaching a verified result. Gemini (`gemini-3-flash-preview`, picked from the live list after the old default was retired) passes the same 7; Jev via OpenRouter routes 6/6 requests correctly. OpenRouter passed 7/7 earlier the same day but the recorded run hit the free key's daily cap (re-run with `--merge`). Claude CLI needs the user's PC |

### Phase 2: COre 2.2 environmental intelligence

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Screenshot perception + accessibility | Implemented | agent prompt carries both the screenshot and the UIA control list |
| 2 | Active apps, window states, dialogs, changes | **Verified on real Windows** | `src/main/situation.js` (UIA windows, visual state, modal/#32770 dialogs, focused controls, opened/closed/retitled/switched); `test/situation.test.js` |
| 3 | File intelligence (PDF, Office, images, audio, video, code, IFC, DXF) | Present from 2.0 | `src/main/fileintel.js` |
| 4, 8 | Project context from both memory systems | Implemented | situation recall through the gateway; project matched from window titles against COre projects and Cortex `Projects/` notes |
| 5 | Understand ongoing work without repeating | Implemented | "continue" / "where were we" / "lanjut" attach `[Ongoing work]` from COre's own records (desktop task and its step, shared tasks per specialist, last requests, last automation); "what am I working on" attaches the situation; e2e |
| 9 | Source verification, confirmed vs inferred | Implemented | every fact tagged observed / inferred / memory / cortex; `groundCheck` flags names in the reply that no source backs (shown to the user) |
| 6 | Application-specific intelligence | Implemented | `src/main/appProfiles.js`: tips for Excel, Word, PowerPoint, Notepad, Explorer, browsers, VS Code, Archicad, plus workflows and lessons learned in that app, given to the agent as hints (approvals unchanged) |
| 7 | Context sync across brain, specialists, gateway, agent | Implemented | one gateway for Prime, every specialist and the agent; the agent starts from the shared situation |
| 10 | Knowledge update after verified completion | Implemented | verified agent outcomes filed under the project in Cortex (e2e + Windows acceptance) |
| Acceptance | Desktop + project + both memories, explained without fabrication | **Pass** | `test/situation.win.test.js` on windows-latest: real project window and its message box observed, project Lakeside inferred from the title, COre memory and `Projects/Lakeside.md` from real Cortex recalled, every fact sourced; invented window flagged by `groundCheck`. The brain's own wording needs a real provider (unverified) |

### Phase 3: COre 2.3 proactive intelligence

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Permissioned event monitoring | Implemented | `src/main/events.js`: file and window sources, each off until allowed; `test/events.test.js` |
| 2 | Background and scheduled workflows | Present (scheduled playbooks, background desktop tasks opt-in) | |
| 5, 8 | Bounded proactive assistance, respects permissions | Implemented | ask-first by default, per-rule cooldown, hourly budget, one run at a time; workflows use the normal tools and approvals |
| 9, 10, 11 | Verified lessons to Cortex; past outcomes before repeating; history not treated as correct | Implemented | rule history (marked "may be outdated") + gateway recall given to each run; outcomes logged to the Cortex logbook |
| Acceptance | Permitted event -> relevance -> history -> authorized workflow -> verified outcome | **Pass (Linux CI, real Cortex; e2e in the real app)** | real file created in a watched folder, unrelated file ignored, Cortex decision recalled with its path, workflow writes a summary that is read back from disk |
| 6 | Automatic resumption after restart | Implemented (opt-in) | `agent.autoResume` + background tasks; otherwise offered |
| 12 | User-approved scheduled maintenance | Implemented | `/memory maintain` dry-run report, `apply [all]`; optional weekly report; daily pass merges only (retiring waits for approval); `test/memgate.test.js` #12 |
| 4 | Identify problems, opportunities, unfinished tasks | Implemented | `src/main/opportunities.js`: interrupted desktop task, overdue / due-today Cortex to-dos (real Cortex test), failed or unverified automations, notes waiting for Cortex; at most 3, sourced, daily or `/suggest`, dismissable, never acts |
| 7 | Specialist collaboration | Improved | every specialist recalls through the gateway (COre + Cortex); cores read each other's results |
| 3 | Reusable skills and playbooks | Present (playbooks, learned desktop workflows) | |

### Phase 4: COre 3.0 unified experience

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Voice, speech recognition, interruption | Present from 2.0 (local STT/TTS, barge-in) | e2e voice tests with stand-ins |
| 2, 10 | Unified memory through the gateway, reliable across restarts | **Measured** | [docs/BENCHMARKS.md](docs/BENCHMARKS.md): recall after 5/5 full restarts, offline queue delivered 5/5 |
| 3, 4 | Jev routing (capabilities, effort, health, latency, cost), effort passed to providers, failover | Verified with a real provider (Groq): effort accepted, failover with continuity | router/effort unit tests; e2e failover. Real providers unverified |
| 6 | Monitoring, diagnostics, transparency | Implemented | `/diagnostics`: brain health and latency per provider, last routing decision, memory, Cortex, agent, sandbox, automations, recent problems (no secrets; e2e); command center, monitor panel, audit log |
| 7, 11 | Updates, recovery, backups, rollback, portable knowledge | Present; backups now include notes waiting for Cortex and automation history | backup e2e, `test/backup.test.js`, updater, `/do undo`. The Cortex vault is the user's own folder (portable, versioned by Cortex) |
| 12 | Responsive on Windows | **Measured on real Windows** | warm budgets checked every CI run (`test/situation.win.test.js`): window list 47 ms, control snapshot 67 ms, full situation with both memories 64 ms (windows-latest, b97e1fc) |
| 9 | Real-world benchmarks | **Implemented** | `npm run benchmark`: memory hit rate and source correctness against real Cortex, restart reliability, injection guard (tuning and held-out sets), OS sandbox blocking, routing accuracy |
| Acceptance | Complex instruction end to end | **Pass with stand-in providers** (CI ubuntu e2e, d0a81ff) | `test-e2e` "PHASE 4 ACCEPTANCE": Scout answers from Cortex, the agent plans, a command fails (exit 3), the agent recovers, writes and re-checks the brief, the file is read back, the verified outcome is filed in Cortex. On real Windows too (`test/agent.win.test.js` PHASE 4, windows-latest b97e1fc): Cortex knowledge, an unauthorized read refused by the AppContainer (DENIED EPERM), recovery, a sandboxed command saves the name, the real app is filled and pressed through UIA, verified from the app and the disk, outcome recalled from Cortex. Real model: the same chain (knowledge, agent loop, failover) verified against Groq in docs/REAL-PROVIDERS.md |

## Blocked or limited

- Installer: bundles Cortex.exe (built from Cortex's PyInstaller recipe) and the local models (speech recognition,
  voice at both qualities, embeddings; ~570 MB) so voice, memory and knowledge work offline from first start.
  `scripts/ci/check-install.js` fails the build if any app file, model or Cortex is missing or Cortex can't
  write + recall (verified on a Linux package build; Windows installer verified in CI).
- Reference research: most documentation sites (Microsoft Learn, MCP, OpenAI, LangGraph, OWASP, NIST, Letta, Mem0,
  LiveKit, Langfuse, OpenTelemetry…) are not reachable from this build environment; only GitHub pages were read.

- Injection detection is weak on unseen attacks: on a fresh, untuned set the pattern guard flags 2/8 (0/6 false positives); Llama Prompt Guard 2 (Groq) flags 3/8, the two together 4/8. Detection is only a warning: the protection is deterministic (retrieved text is fenced as data, COre's action tags in it are broken, every action needs approval, commands run sandboxed), and the real-model test shows injected instructions not being obeyed.

- Real providers: Groq, Gemini and Jev verified; OpenRouter's recorded run hit the free daily cap (50 requests/day without credit); Claude CLI not run (needs the user's signed-in PC). Free tiers rate-limit long runs (COre waits and retries).
- Office apps: on a headless CI desktop LibreOffice Calc exposes only its window to UI Automation, so COre uses the keyboard route from its app profile and verifies from the saved file (`test/office.win.test.js`). Microsoft Office itself is not installed on CI.
- Node package managers cannot run inside the Windows AppContainer (libuv named pipes are denied); they run with Job limits only.
- Headless CI desktop: some apps (new Notepad's XAML view) expose little to UI Automation there.

## Next execution target

1. Re-run OpenRouter when its daily cap resets (`npm run validate:providers -- --provider openrouter --no-jev --merge --out docs/REAL-PROVIDERS.md`).
2. On the user's Windows PC: Claude CLI brain, real microphone latency and barge-in feel, presence, typing in Obsidian, Microsoft Office apps.
