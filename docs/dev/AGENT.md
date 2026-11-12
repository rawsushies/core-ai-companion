# Desktop agent

COre can work through a task on your desktop: "/do rename the screenshots on my desktop by date", "/do open
calculator and work out 18% of 2,450". It's **off by default** (Settings → Agent).

## How a task runs

1. You start it, at the PC, with `/do TASK` in the chat. The phone can't start it.
2. Each step, COre takes a fresh screenshot (its own windows hidden) and asks its own brain session for **one**
   action.
3. The action is validated (see below). Anything that changes something (click, typing, keys, opening an app)
   shows a card in the chat with **Allow**, **Allow all steps** and **Stop**. For clicks, COre points at the target.
4. A fixed driver performs it, the step is logged in the chat and in `logs/tools.log`, and the loop repeats.
5. It ends when the brain says done, asks you a question, hits the step limit (25 by default), or you stop it.

Stop at any time: **Esc** (global while a task runs), the **Stop** button, or typing any message.

## Safety policy (13.0)

Every action passes one deterministic gate, `src/main/policy` (no model involved):

| Class | Examples | What happens |
|---|---|---|
| R0 view | look, read, wait, scroll | runs |
| R1 routine in scope | typing and clicking in granted apps, writing/renaming in the shared folder (backed up), sandboxed commands, granted websites | runs without asking under a grant, journaled |
| R2 high impact | delete, send (outbox, Send buttons), install, other websites, unsandboxed commands, anything outside the folder | asks, unless the task's grant names the category (Settings → Agent → `grantCategories`) |
| R3 boundary | payments, security settings | always asks |
| — | passwords and codes, COre's own data folder, refused commands | refused |

- **Grants**: "Approve every step" is manual mode (no grant). "Approve the plan" and "No questions" run under a
  signed grant for the shared folder; **Allow all for this task** turns manual mode into such a grant (commands
  still ask one by one). A grant can't be widened; it is checked on every step.
- **Taint**: an email address, website or command that came from a file, page, email or screen text (not from
  you) is never used without asking, even inside the grant. Detection of injected text is only a warning; this
  rule is what stops it.
- **Journal**: every step is written to `missions/<task>/journal.jsonl` before and after it runs (hash-chained,
  fsync'd); `/do undo` restores every file the task changed.
- **Stops**: Esc, Stop, the emergency hotkey (stops the policy itself), and a file named `STOP` in COre's data
  folder, which refuses every action until it is deleted. `/diagnostics` shows how many steps ran, asked or
  were refused.

## Missions (13.0): `/autopilot GOAL`

1. COre shows **one** card: the folders, what may happen without asking, the budget and the expiry. Approve once.
2. It plans 1–10 subgoals, each with a check (a file that must exist or contain something). Each subgoal runs
   through the same agent loop and safety policy as `/do`, so it can never do more than the grant allows.
3. Each subgoal is verified from disk; only when no file can show it does Sentinel judge, and the report says so.
4. A subgoal that fails is retried once with what went wrong; then the mission stops and asks you.
5. The report lists every subgoal with its evidence. `/mission undo` puts back every file the mission changed;
   `/mission stop`, Esc, Stop and the emergency hotkey end it.
6. **Learning**: a verified mission is saved as a playbook route; a nearly identical goal reuses it (still checked
   step by step). **Hands lease**: mouse and keyboard steps wait while you use the PC.
7. **Standing missions**: `/mission allow NAME` lets a scheduled desktop playbook run on its own, under a grant you
   approve once (30 days, signed, never widened). `/mission revoke NAME` ends it. The command center's Missions
   card shows the plan, the evidence for each step, and Stop/Undo.

## Actions

| Action | Limits |
|---|---|
| click (left / right / middle, double) | inside the screenshot |
| move, scroll | scroll ±20 notches |
| type | 1–500 characters, no control characters |
| key | allowlist: modifiers + letters, digits, F1–F12, Enter, Tab, Esc, arrows, Home/End, PageUp/Down… Blocked: Ctrl+Alt+Del, Win+L, Ctrl+Shift+Esc, Alt+F4 |
| open | the same safe app list as the open skill |
| wait | 0.2–5 s |
| ask, done | hand back to you |

The brain is told never to enter passwords, payment details or personal data you didn't give it in the task.

## Drivers (parameters are data, never shell strings)

- **Linux (X11):** `xdotool` with an argument array, for example `['type', '--delay', '12', '--', text]`.
- **Windows:** one fixed PowerShell helper (C# `SendInput`, DPI-aware) that reads JSON lines, for example
  `{"op":"click","x":…}`. Text is sent as Unicode key events. **Not yet tested on real Windows.**
- macOS: not supported yet.

## Tested

- Unit: validation, blocked keys, coordinate mapping (scale factors and multi-monitor offsets), key mapping, the
  Linux driver's argument arrays, and the runner (approval, allow all, decline, invalid-action limit, step limit,
  stop, ask).
- End to end (Linux, Xvfb, real `xdotool`): `/do` → approve the click → allow all → COre clicks into a separate
  window's text box and types into it; the box contains the text.
