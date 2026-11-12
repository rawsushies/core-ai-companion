# COre roadmap and status

Evidence-based tracker for the master roadmap. A requirement counts only when
its acceptance test passes against real components (real Cortex, real Windows
apps, real providers). Mocked tests are listed separately and never count as
real-world validation.

**Overall estimated completion: 47%** (planning baseline 38%; recalculated from
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
| 1 COre 2.1 desktop operator | In progress | ~60% |
| 2 COre 2.2 environmental intelligence | Partly present from 2.0 (file intelligence, project context) | ~25% |
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
| Windows UI Automation + accessibility tree | Partly verified on real Windows | CI windows-latest: real Notepad text area set and read back; WinForms edit/button found via UIA + Win32 fallback. Check box detection fix pending CI. |
| Control-level actions (press, fill, expand, focus) | Implemented, unit-tested (mocked UIA) | `test/uia.test.js` |
| Planner (plan + done-when) | Implemented, unit + e2e | `test/agent-tools.test.js` planning test |
| Persistent state, checkpoints, resume | Implemented (2.0), unit + e2e | `/do resume`, checkpoint tests |
| Windows process isolation | **Not done** | Linux bubblewrap only (`test/agent-tools.test.js` real sandbox). Windows needs Job Objects / AppContainer. |
| Least privilege, approvals, e-stop, audit, rollback | Implemented | e2e emergency stop, tools + undo, plan approval |
| Timeouts, process-tree kill, retries | Implemented | taskkill /T on Windows; failure advisor |
| Memory gateway in planning and execution | Implemented | agent experience reads Cortex; lessons and outcomes written back |
| Model switch keeps context | Verified with stand-in providers | e2e failover with continuity |
| Real AI providers | **Unverified** | build sandbox cannot reach provider APIs |

## Blocked or limited

- Real provider validation (Gemini, Groq, OpenRouter, Jev): no network access from the build environment.
- Windows OS sandbox: not implemented yet (next target).
- Headless CI desktop: some apps (new Notepad's XAML view) expose little to UI Automation there.

## Next execution target

1. Confirm the WinForms fill/press/toggle test passes on Windows CI.
2. Windows process isolation for agent commands (Job Object: kill-on-close, memory and process limits; restricted token where possible).
3. Phase 1 acceptance test: a multi-step task across real Windows apps with an interruption and resume, in CI.
