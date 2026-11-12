# COre roadmap and status

Evidence-based tracker for the master roadmap. A requirement counts only when
its acceptance test passes against real components (real Cortex, real Windows
apps, real providers). Mocked tests are listed separately and never count as
real-world validation.

The earlier roadmap (versions 1 to 10) is kept in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md).

**Overall estimated completion: 55%** (planning baseline 38%; recalculated from
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
| 1 COre 2.1 desktop operator | Acceptance passing on real Windows CI; real-provider validation open | ~85% |
| 2 COre 2.2 environmental intelligence | Situation awareness + sourced explanation in place; acceptance test on real Windows | ~45% |
| 3 COre 2.3 proactive intelligence | Partly present (scheduled playbooks, learned workflows) | ~20% |
| 4 COre 3.0 unified experience | Partly present (voice, routing, command center) | ~30% |

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
| Windows file-system + network isolation | Implemented (AppContainer); CI confirming | `COre.AgentSandbox` AppContainer: home folder read/write/list denied, other folders denied, loopback network denied, each compared with the same operation outside the box (passed on CI run 74ef60f). npm/npx/pnpm/yarn run under the Job only (Node child processes cannot start inside an AppContainer); the command note says so |
| Least privilege, approvals, e-stop, audit, rollback | Implemented | e2e emergency stop, tools + undo, plan approval |
| Timeouts, process-tree kill, retries | Verified | taskkill /T; Job kill-on-close; failure advisor |
| Memory gateway in planning and execution | Implemented | agent experience reads Cortex; lessons and outcomes written back |
| Model switch keeps context | Verified with stand-in providers | e2e failover with continuity |
| Real AI providers | **Unverified** | build sandbox cannot reach provider APIs |

### Phase 2: COre 2.2 environmental intelligence

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Screenshot perception + accessibility | Implemented | agent prompt carries both the screenshot and the UIA control list |
| 2 | Active apps, window states, dialogs, changes | Implemented; Windows CI confirming | `src/main/situation.js` (UIA windows, visual state, modal/#32770 dialogs, focused controls, opened/closed/retitled/switched); `test/situation.test.js` |
| 3 | File intelligence (PDF, Office, images, audio, video, code, IFC, DXF) | Present from 2.0 | `src/main/fileintel.js` |
| 4, 8 | Project context from both memory systems | Implemented | situation recall through the gateway; project matched from window titles against COre projects and Cortex `Projects/` notes |
| 5 | Understand ongoing work without repeating | Partly | "what am I working on" / "where was I" attach the situation; agent resumes from checkpoints |
| 9 | Source verification, confirmed vs inferred | Implemented | every fact tagged observed / inferred / memory / cortex; `groundCheck` flags names in the reply that no source backs (shown to the user) |
| 6, 7, 10 | App-specific workflows, context sync, knowledge updates after verified tasks | Partly (learned workflows, outcomes to Cortex) | |
| Acceptance | Desktop + project + both memories, explained without fabrication | Test written on real Windows + real Cortex (`test/situation.win.test.js`); awaiting CI | |

## Blocked or limited

- Real provider validation (Gemini, Groq, OpenRouter, Jev): no network access from the build environment.
- Node package managers cannot run inside the Windows AppContainer (libuv named pipes are denied); they run with Job limits only.
- Headless CI desktop: some apps (new Notepad's XAML view) expose little to UI Automation there.

## Next execution target

1. Confirm the AppContainer boundary and the Phase 2 acceptance test on Windows CI.
2. Phase 2: context synchronization across brain, specialists, gateway and agent (one shared situation per task); knowledge updates after verified task completion.
3. Phase 3: permissioned event monitoring feeding bounded proactive workflows.
