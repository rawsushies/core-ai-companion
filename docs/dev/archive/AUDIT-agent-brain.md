# COre audit: autonomous agent and brain (November 2026)

An honest account of what COre can do today, how it was verified, and what is
still missing. "Verified" means an automated test exercises the real code path;
the end-to-end suite drives the packaged app under Xvfb with real input
(xdotool), a scripted stand-in for the Claude Code CLI, and local stand-ins for
a second AI provider and for Jev's decision endpoint.

Test totals at the time of writing: `npm test` 264 pass, `npm run e2e` 31 pass.

## Architecture in one picture

```
user message
  → main.js: quick replies, commands (/do, /skill, /center), memory + files + playbook context
  → Brain.ask (src/main/brain/index.js)
      1. hard limits in code: key present, not cooling down, vision, context size   (router.js eligible)
      2. fast decision: task, complexity, effort, specialist, acts-on-system,      (decide.js)
         underspecified, model choice. Jev when a key exists, else a local classifier
      3. order: capability fit, measured health/speed, cost, preference, Jev's pick  (router.js order)
      4. per-request model: strong model for deep work (Claude: one-shot resume)     (router.js modelFor)
      5. continuity: a model taking over gets a recap of the turns it missed        (Brain._recapFor)
      6. failover with classified cooldowns shared by all brains                     (Router.failure)
  → main brain (Claude, Gemini, Groq, OpenRouter, Ollama, custom) plans and answers,
    may delegate to specialists, propose file changes, or ask the user to start /do
  → desktop agent (agent.js + agentTools.js) for multi-step work on the computer
```

Jev and the local classifier only advise. Permissions are enforced by code
that never reads their output: the agent's action validator, the command
policy, folder jail, approvals, the injection guard and the emergency stop.

## What works (verified)

| Area | What | Evidence |
|---|---|---|
| Intent | Every user turn is classified (task, complexity, effort, specialist, acts on system, vague) by Jev in one batched typed request, or by the local classifier | `test/decide.test.js`; e2e "Jev decides every turn" (checks the request shape, key and audit record) |
| Model routing | Hard eligibility (vision, context, health), then capability/speed/cost scoring; Jev's confident model pick wins | `test/router.test.js`, `test/decide.test.js`; e2e: Jev picks the backup model and it answers |
| Escalation | Complex turns run on the strong model (Claude haiku → sonnet for that request, same conversation) | `decide.test.js` "complex work escalates"; e2e "smart routing" (specialists on sonnet, chat on haiku) |
| Fallback and retry | Failures classified (auth, rate, overload, timeout, network, model); cooldowns grow, honour Retry-After, are shared by all brains, clear on new keys or settings; strong→fast step-down inside Claude | `router.test.js`; e2e "failover with continuity" (real usage-limit error, Claude not even started while resting) |
| Continuity | Switching models keeps the conversation: the new model gets the missed turns once | `decide.test.js` "continuity"; e2e handoff checks the backup received the earlier turns |
| Memory | Automatic capture, confidence, contradictions, history, hybrid search, consolidation, pins; past desktop lessons fed to new tasks | `test/memory-engine.test.js`, agent advisor test, e2e memory tests |
| Desktop agent | Screenshot → one validated action → approval → real input; tools for commands, files, https pages; verification before done; failure advisor; checkpoints and `/do resume`; `/do undo` | `test/agent*.test.js`; e2e real clicks/typing into a window, tools + undo, emergency stop |
| Learning | Lessons from failed steps are stored and shown to later similar tasks; playbooks learned from chat with `/skill save` | agent advisor test; e2e playbooks |
| Specialists | Scout, Forge, Sentinel, Archivist, Navigator; Sentinel reviews Forge; shared tasks; routing hints suggest delegation | e2e Meiosis, shared task, review, Navigator, Archivist |
| Security | No shell, command blocklist, per-command approval, folder jail, secret files refused, backups and undo, untrusted-content fencing, audit log, emergency stop | `test/agent-tools.test.js`, `test/guard.test.js`; e2e emergency stop and tools |
| Files | PDF, Office, sheets, slides, images, code, IFC, DXF read locally; audio/video decoded and transcribed | `test/fileintel.test.js`; e2e files |

## Incomplete or limited (honest)

- **Jev against the real service is not verified here.** This sandbox cannot reach
  api.typesafe.ai or openrouter.ai. The client follows the request shape used by
  the reference implementations and is tested against a local stand-in; the first
  real call may need small adjustments if the live response differs.
- **Real providers other than the fake Claude CLI were not called** for the same
  reason (Gemini, Groq, OpenRouter, Ollama). Their HTTP code paths are the same
  as the stand-in's OpenAI-compatible path.
- **The agent works one action per step** with a screenshot each time. It does not
  read accessibility trees, so small or unlabeled controls can be missed, and long
  tasks are slow. Background (unattended) execution is limited to scheduled
  playbooks; the desktop agent itself needs the user to start it.
- **Commands are not OS-sandboxed** (no container or VM). They are argv-only,
  blocklisted, folder-jailed, secret-free, time-limited, logged and approved one by one.
- **Jev effort levels** steer model depth but are not passed to providers as a
  reasoning-effort parameter (switching it would restart Claude's warm session).
- **Costs are relative tiers**, not live prices; there is no spending cap.
- **Learning is shallow**: lessons are text memories retrieved by similarity, not
  a trained policy. Playbooks are saved only when the user asks.
- **Cross-device sync** covers memory (Google Drive) and the phone companion;
  playbooks, files and task state stay on the PC.

## Next steps worth doing

1. Accessibility-tree reading (UI Automation on Windows, AT-SPI on Linux) so the
   agent can target controls by name instead of pixels.
2. One live smoke test of Jev and each provider with real keys, recorded as a
   fixture so CI keeps the shape honest.
3. Pass effort to providers that accept it per request (Claude `--effort` in
   one-shot runs, OpenAI-style `reasoning_effort`).
4. A spending/usage panel per provider and an optional daily cap.
5. Optional container sandbox for commands (Windows Sandbox / bubblewrap).
