# Meiosis Mode: design

Four cores total: **Prime** (COre itself) plus up to three specialists, **Scout**, **Forge** and **Sentinel**.
They are role profiles over the existing Brain provider chain (Claude Code, Gemini, Groq, OpenRouter,
Ollama, OpenAI-compatible). They are not new AI engines.

## Identities (`src/main/cores.js`)
- Defaults: Prime (emerald, the main orb, default recipient), Scout (ice, research), Forge (ember, build),
  Sentinel (violet, review/QA). Each has `id, name, aliases, role, color, voice, semitones, prompt`.
- Configurable in `config.json` → `meiosis.cores` (names, aliases, colours, voices). Validated: ids fixed,
  names unique and unambiguous, colours `#rrggbb`. Bad entries fall back to the defaults.
- Prime is always the existing COre: same session, orb, chat and voice. It is never a fifth window.

## One timeline
- The existing persisted transcript is the single conversation. Entries gain `author` (`user`,
  `prime`, `scout`, `forge`, `sentinel`, `system`) and `kind` (`message`, `progress`, `tool`, `error`,
  `permission`). Entries saved by older versions have no author and read as Prime. Nothing is migrated
  destructively.
- The chat shows every core message with a name and role label plus its colour (never colour alone), and
  marks progress, tool actions, errors and permission requests distinctly.

## Routing
- `@Name` or `@alias` at the start of a message (or `Name,` / `Name:` when spoken) addresses that core.
  No mention means Prime. An unknown `@name` is not sent: COre lists the names it knows.
- The chat has `@` autocomplete and a recipient picker ("To: COre ▾"). The current recipient is always visible.
- One specialist addressed: the message goes to that specialist only (it splits off if not present).
- Several cores addressed: a **shared task** (`task-<id>`) with one step per core. The specialists work in
  parallel; Prime posts a short unified summary when all steps finish (or report what failed).
- Messages are never silently fanned out to several cores.

## Isolation and shared state
- Each specialist has its own Brain instance and session (its own context), kept while it's on screen
  and disposed when it merges back. Prime's session is untouched.
- The task record (steps, statuses, results) is shared and visible in the timeline.

## Voice and presence
- The existing speech floor guarantees one voice at a time, Prime first. Specialists speak a one-sentence
  summary with their own voice. Floating subtitles carry the speaker's name and colour.
- Smoke, gestures, captions, reduced motion and caption settings are unchanged.

## Limits (honest)
- With a project folder shared (Settings → Projects), every core can **read** it through validated
  read-only tools (`src/main/tools.js`: list/read/find, contained by realpath, secrets refused, capped,
  audited). There is still **no writing, shell or web**: writes need previews and confirmations (next
  Phase 4 slice). Scout answers from model knowledge plus the project and must state uncertainty.

## Slices
1 identities/config · 2 message model · 3 chat UI · 4 mentions/picker · 5 clone integration (persistent
role sessions) · 6 shared tasks · 7 subtitle attribution · 8 parallel coordination + Prime summary ·
9 cancellation/recovery · 10 tests and real-Electron validation.
