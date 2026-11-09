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
