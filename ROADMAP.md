# COre roadmap and status

Evidence-based tracker for the master roadmap. A requirement counts only when
its acceptance test passes against real components (real Cortex, real Windows
apps, real providers). Mocked tests are listed separately and never count as
real-world validation.

The earlier roadmap (versions 1 to 10) is kept in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md).

**Overall estimated completion: 81%** (planning baseline 38%; recalculated from
verified acceptance criteria below, last update 2026-11-12).

## Memory architecture status

- **COre native memory** (`src/main/memory.js`) = active memory: profile,
  preferences, facts, confidence and decay, contradictions, task episodes.
- **Cortex** (`rawsushies/cortex-ai-brain`, MCP over stdio) = long-term
  knowledge: project decisions, lessons, linked notes, logbook, version history.
- **Memory gateway** (`src/main/memgate.js`) = the only memory interface the
  brain, specialists and agent use. One destination per kind (decision, lesson,
  knowledge, research go to Cortex; the rest stays native). No third engine.

## Cortex integration status

Connected through `src/main/cortex.js` (MCP client). Off until the user turns it
on (Settings, Privacy). History import stays off (`CORTEX_AUTO_IMPORT=off`);
Cortex's own consent gate (`import_history`) is never touched. COre never writes
vault files directly.

## Phase status

| Phase | Status | Estimate |
|---|---|---|
| 0 Memory integration | Done for 10/10 acceptance tests (real Cortex) | complete |
| 1 COre 2.1 desktop operator | Acceptance and security boundaries pass on real Windows CI; real-provider validation open | ~90% |
| 2 COre 2.2 environmental intelligence | Acceptance passes on real Windows + real Cortex; app profiles, context sync, verified knowledge updates | ~85% |
| 3 COre 2.3 proactive intelligence | Acceptance passes (unit with real Cortex + e2e); opportunity detection, approved maintenance, opt-in auto-resume | ~80% |
| 4 COre 3.0 unified experience | Combined acceptance passes in the real app and on real Windows (scripted reasoning); benchmarks, diagnostics, responsiveness budgets | ~65% |

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
| Real AI providers | **Unverified** | build sandbox cannot reach provider APIs |

### Phase 2: COre 2.2 environmental intelligence

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Screenshot perception + accessibility | Implemented | agent prompt carries both the screenshot and the UIA control list |
| 2 | Active apps, window states, dialogs, changes | **Verified on real Windows** | `src/main/situation.js` (UIA windows, visual state, modal/#32770 dialogs, focused controls, opened/closed/retitled/switched); `test/situation.test.js` |
| 3 | File intelligence (PDF, Office, images, audio, video, code, IFC, DXF) | Present from 2.0 | `src/main/fileintel.js` |
| 4, 8 | Project context from both memory systems | Implemented | situation recall through the gateway; project matched from window titles against COre projects and Cortex `Projects/` notes |
| 5 | Understand ongoing work without repeating | Partly | "what am I working on" / "where was I" attach the situation; agent resumes from checkpoints |
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
| 3, 4 | Jev routing (capabilities, effort, health, latency, cost), effort passed to providers, failover | Implemented, verified with stand-ins | router/effort unit tests; e2e failover. Real providers unverified |
| 6 | Monitoring, diagnostics, transparency | Implemented | `/diagnostics`: brain health and latency per provider, last routing decision, memory, Cortex, agent, sandbox, automations, recent problems (no secrets; e2e); command center, monitor panel, audit log |
| 7, 11 | Updates, recovery, backups, rollback, portable knowledge | Present; backups now include notes waiting for Cortex and automation history | backup e2e, `test/backup.test.js`, updater, `/do undo`. The Cortex vault is the user's own folder (portable, versioned by Cortex) |
| 12 | Responsive on Windows | **Measured on real Windows** | warm budgets checked every CI run (`test/situation.win.test.js`): window list 47 ms, control snapshot 67 ms, full situation with both memories 64 ms (windows-latest, b97e1fc) |
| 9 | Real-world benchmarks | **Implemented** | `npm run benchmark`: memory hit rate and source correctness against real Cortex, restart reliability, injection guard (tuning and held-out sets), OS sandbox blocking, routing accuracy |
| Acceptance | Complex instruction end to end | **Pass with stand-in providers** (CI ubuntu e2e, d0a81ff) | `test-e2e` "PHASE 4 ACCEPTANCE": Scout answers from Cortex, the agent plans, a command fails (exit 3), the agent recovers, writes and re-checks the brief, the file is read back, the verified outcome is filed in Cortex. On real Windows too (`test/agent.win.test.js` PHASE 4, windows-latest b97e1fc): Cortex knowledge, an unauthorized read refused by the AppContainer (DENIED EPERM), recovery, a sandboxed command saves the name, the real app is filled and pressed through UIA, verified from the app and the disk, outcome recalled from Cortex. Real providers: not yet |

## Blocked or limited

- Injection guard on held-out examples: 4/6 flagged, 1/4 benign flagged (see benchmarks); every retrieved text is fenced as data regardless.

- Real provider validation (Gemini, Groq, OpenRouter, Jev): no network access from the build environment.
- Node package managers cannot run inside the Windows AppContainer (libuv named pipes are denied); they run with Job limits only.
- Headless CI desktop: some apps (new Notepad's XAML view) expose little to UI Automation there.

## Next execution target

1. Real-provider validation once network access to provider APIs is available.
