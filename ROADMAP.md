# COre roadmap to v10.0.0

COre is developed in an automatic loop: each phase is built, tested (unit tests + the real Electron app
headless + real Claude where possible), audited for bugs, versioned, and pushed to `main` (installed copies
auto-update). Every loop iteration: **find bugs → fix → build the next phase's features → research other
companion projects for ideas → measure performance → ship**.

Rules for every phase
- Keep CPU/GPU light: no full-screen work, idle frame cap, no per-frame window resizes.
- Never break: voice/text harmony, transparency, auto-update, Windows support.
- Each phase ends with: tests green, app smoke-tested, CHANGELOG entry, version bump, push.

Status legend: ✅ shipped · 🔨 in progress · ⏳ planned

## ✅ v0.4.1 — Alive and quick (done)

## ✅ v0.5.0 — Harmony & glass
- Fix: flicker while dragging / idle (fixed-size stage that only moves; no resizes during a drag; chat
  follows on drop).
- Fix: replies stopping after a few sentences (typed replies are spoken in full; code blocks skipped).
- Voice ⇄ text harmony: each sentence's words are revealed over the real length of its audio.
- Chat tab redesign: smaller, translucent glass, shows only the latest exchange, fades out when idle,
  full on hover/focus; history expandable.

## ✅ v1.0.0 — Real app
- Windows installer (.exe, NSIS) with Start-menu/desktop shortcuts and a proper **uninstaller**; built by
  GitHub Actions on Windows and attached to GitHub Releases; updater learns release installs.
- Settings window (all options in a UI, not config.json): brains, voice, look, hotkeys, privacy, startup.
- Start with Windows (optional), single-click "Quit/Restart/Reset" maintenance tools.

## ✅ v2.0.0 — Body language
- Gesture library: 20+ cheap hand/body animations (wave, thumbs up, shrug, count on fingers, clap, facepalm,
  point up/down/left/right, beckon, stop palm, OK sign, peace, heart hands, thinking chin, salute, spin,
  bow, nod, shake, celebrate, juggle…), all from the same particle arms (no extra GPU work).
- `[[gesture name]]` tag + automatic gestures from the reply's meaning.

## ✅ v3.0.0 — Shape-shifting
- COre forms shapes/emoji out of its smoke (laughing face, heart, check mark, question mark, star, sun,
  moon, music note, arrows, numbers/letters…) with matching voice expression (giggle, hum, sigh).
- `[[form laugh]]` tag; particle targets sampled from tiny vector glyphs (cheap).

## ✅ v4.0.0 — Companion presence
- Idle chit-chat: after a quiet while, COre starts a short, relevant conversation (time of day, what's on
  screen if allowed, memories, reminders), rate-limited and respectful (do-not-disturb, fullscreen apps,
  meetings).
- Interactions: poke, pet, toss, tickle reactions; mini games (riddles, 20 questions, trivia).

## ✅ v5.0.0 — Many COres
- Clones: COre splits (meiosis animation) into helpers, each with its own window, voice, context and task;
  they lay themselves out so they never overlap each other or your focus window; merge back when done.
- Voice routing so clones never talk over each other (queue / priority / per-clone voice).

## ✅ v6.0.0 — Hands-free
- Wake word ("Hey COre", on-device), push-to-talk hold mode, barge-in (talk over COre to interrupt),
  continuous conversation mode.

## ✅ v7.0.0 — Screen partner
- Optional watch mode: COre notices errors/dialogs on screen and offers help; smarter pointing (UI element
  detection), multi-monitor presence.

## ✅ v8.0.0 — Skills
- Plugin/skill system (safe, permissioned): timers, notes, weather, music control, app launcher, web
  search via the brain, calendar integrations.

## ✅ v9.0.0 — Polish
- Themes/skins (colours, styles), languages, accessibility, performance profiles, crash reporting (local),
  onboarding tour.

## 🔨 v10.0.0 — Release
- Full audit, performance pass, docs, signed installer, release notes.
