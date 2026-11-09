# Changelog

## Unreleased

### Glance: a card beside the orb
- "What's playing?" shows the current song, artist and progress next to COre. "Show me the lyrics" shows the
  synced lyrics, with the line being sung in Emerald. "Hide that" closes it. COre can also show any short list or
  numbers on its own ("show me today's plan").
- The song comes from the system media session: Windows media controls (Spotify, browsers, most players) or
  playerctl on Linux. It's read only while a music or lyrics card is open, and the card closes by itself after a
  minute of pause.
- Lyrics come from lrclib.net (free, no account). Only the song title and artist are sent, and only when you ask
  for lyrics. There's an off switch (`skills.lyrics`).

### Instant answers
- Short requests are answered on the spot without the brain: the time, the date, play / pause / next / previous /
  louder / quieter / mute, show or hide the lyrics or now-playing card. Measured in the app: about 40–200 ms
  instead of a model round trip, and no usage. Anything longer still goes to the brain. Switch: `skills.quick`.
- Notes in the chat lost their emoji (Noted, Music, Opening, Timer set).

### Chat redesign (brand kit)
- The chat under the orb is one clear panel: no fill (your screen shows through), a solid brand-coloured
  frame and dividers. A header shows COre's real mark, its status (Online / Thinking… / Speaking / Offline),
  and history, settings and hide buttons.
- Replies are Smoke bubbles grouped under the speaker's avatar (COre's mark, or the specialist's colour orb).
  Your messages are Void bubbles with an Emerald edge. The input is one filled pill with the recipient orb and
  mic inside it, plus a round Emerald send button.
- Notes like "Remembered…" are plain text with a dark halo, not a bubble. Emoji removed from notes.
- Quick settings are cards in the same style. Back and the title sit in the header, empty reminders are hidden,
  and slider values show in brand mono.
- Gaps in the panel click through to the app below (Windows and macOS).
- Brand audit across windows: the subtitle no longer uppercases names (it showed "CORE"), the old green and
  off-palette greys and whites are replaced with brand colours, the History panel and Settings use the real
  mark and Inter Display, and the History panel matches the chat.

### Lighter on CPU and GPU (measured)
- While idle, COre now sleeps between frames instead of keeping the compositor awake at the display rate.
- New light rendering path: 8-bit buffers, lower resolution and an active-frame cap. It's used by safe
  graphics, the Battery profile and every helper core.
- Measured idle CPU in safe graphics mode (software rendering): **173% → 37%** of one core. On a real GPU these
  savings are GPU time and power instead.
- Profiles retuned: Battery (8,000 particles, 65% resolution, 10 fps idle, 30 fps cap), Balanced (20,000,
  90%, 20 fps idle), Best quality (40,000, full, 45 fps idle). Default idle frame rate 30 → 20.
- Helper cores render at 4,000 particles, 70% resolution and 10 fps idle, light buffers.
- Overlay frame counters (`window.__coreStats()`) and, with `CORE_DEBUG=1`, latency logs (first text, first
  speech). Measured with the real Claude: about 0.7 s to the first word of text and 1.7 s to the first audio on
  warm turns.

### Archicad (read-only proof of concept)
- Turn on Settings → Skills → "Read my open Archicad project" and ask COre how many doors, walls or windows the
  open project has. COre talks to Archicad's built-in JSON API on this PC only (127.0.0.1, ports 19723–19743)
  and can only use read commands; nothing in the model can be changed. Not yet tested against a real
  Archicad. See docs/dev/RESEARCH-PHASE5-6.md for the integration research (Archicad, Revit via pyRevit
  Routes, Windows UI Automation) and the secure Android companion design.

### Approved file changes (you click Apply)
- With Settings → Projects → "Let cores propose changes" on (off by default), a core can propose a whole file:
  it writes the new file in a code block tagged `file=path`. The chat shows a card with the file, +/− counts
  and a red/green diff. **Nothing is written until you click Apply**, and Reject throws it away.
- Apply refuses if the file changed since the proposal (so your edits are never overwritten), backs the
  original up, and writes atomically. Every applied change has **Undo**, which also refuses if you edited the
  file afterwards.
- New files only inside existing folders of the shared project. Same containment and secret rules as
  reading, text only, size-capped. No deleting, renaming or running anything. Every write, rejection and
  undo goes into `logs/tools.log`.

### Cores can read your project (read-only, with permission)
- Share one project folder in Settings → Projects (system folder picker; Stop sharing at any time). COre and
  its cores can then list, read and search it with `[[list]]`, `[[read]]` and `[[find]]`, and answer from
  the actual files ("Forge searched for TODO (1 hit)").
- Read-only by design: no writing, no running anything, no shell. Paths are resolved through symlinks, so
  nothing outside the folder is reachable. Secret-looking files (`.env`, keys, `credentials.json`…) are always
  refused, dependency folders are skipped, and file size and output are capped.
- Every access appears in the chat as it happens and is written to `logs/tools.log`.
- Specialists can take up to three rounds of reading in their own session before answering.

### Meiosis Mode: four cores, one chat
- **Minimal, on-brand chat** (replaces the glass bubbles from earlier in this cycle):
  - A flat Void panel at 88% opacity with a hairline border, narrower at 320 px. When idle it fades to 28% so
    it blends back into your screen.
  - Replies are plain text under a small coloured name ("Scout · Research"). Your messages are a quiet block
    on the right, and system notes are muted text.
  - The core wheel and @ chips are flat coloured dots. The rings and highlights stay subtle.
- COre's brand type (Inter, Inter Display, JetBrains Mono, all OFL) is now bundled with the app and used in the
  chat, Settings, history and subtitles, so it looks the same on every PC. Settings and history use the brand
  palette.
- New chat look: replies are glassy bubbles tinted in each core's colour, each with a small swirling
  smoke-orb avatar. Consecutive replies from the same core share one avatar. Your messages show which
  cores they went to as coloured chips, and progress and errors are small centred pills. The old coloured
  side bars are gone.
- The **core wheel**: the orb next to the input shows who you're talking to. Click it and a ring of the four
  cores spins in, turning the chosen one to the top. Arrow keys turn it, Enter or a click picks. Typing `@`
  shows the cores as orb pills. Animations stop with reduced motion, and names are always written out.
- COre is now four cores total: **COre** (Prime, the coordinator and default recipient) and three
  specialists that split off as smoke helpers. **Scout** researches and compares, **Forge** builds and drafts,
  **Sentinel** reviews and finds problems. They are role profiles over the same brain you already use, not
  extra AI services.
- One chat for all of them. Every reply is labelled with the core's name and role in its colour. Progress,
  errors and actions are marked, and messages you send to a specialist say who they went to.
- Talk to a core by starting with `@Scout`, `@Forge`, `@Sentinel` or `@COre` (autocomplete pops up when you
  type `@`), with the recipient chip next to the input, by clicking a specialist's smoke, or by voice:
  "Scout, …". With no name, the message goes to COre. Unknown names aren't guessed: COre lists the names it knows.
- Address several at once (`@Scout @Sentinel review this`) to start a shared task. They work in parallel,
  then COre sums up the results in one answer.
- Each specialist keeps its own conversation (separate context) while it's on screen, handles messages to
  it one at a time, and merges back after 10 idle minutes (or when poked). Stop also stops specialists.
- COre can hand work to a specialist itself (`[[delegate Scout …]]`). The older `[[clone …]]` and `/clone`
  pick a fitting specialist.
- Floating subtitles show who is speaking, and only one core speaks at a time (COre first).
- Specialists can't open files, run commands or browse yet (that's the coming permissioned task engine); their
  instructions say so, so they won't pretend.
- Names, aliases, colours and voices are configurable in `config.json` → `meiosis.cores`.
- `/stop @Scout` and `/merge @Forge` act on specific cores (`/stop` and `/merge` alone act on all).
- A shared task interrupted by COre closing is marked as interrupted, and COre tells you when it next starts.
  It is never re-run on its own.
- COre's summary of a shared task waits until every specialist has finished speaking, instead of cutting
  them off. Only you talking to COre interrupts a specialist.

### Release engineering
- Releases now come only from an explicit version tag, never from a `package.json` change. They go through
  blocking gates (syntax check, tests, packaged-app self-test, Windows installer install/uninstall test) and
  land as a **draft** for a human to publish. See docs/dev/RELEASING.md.
- New CI on every branch and pull request (Linux + Windows), with blocking tests.
- Fixed the release build: it ran two GitHub publishers that raced, so releases lost files and never
  included `latest.yml`. Builds now upload the installer, blockmap, `latest.yml` and SHA256SUMS together.
- Removed the code-signing publisher check from unsigned builds (it would have made installed copies reject
  every update).
- `--smoke-test=<file>`: COre can self-test (windows load, orb draws, native modules and worker files
  present) and exit with a pass/fail code. Used by CI and the release gates.
- The Claude CLI tests now also run on Windows, through a `.cmd` shim like the real CLI.

### Updates you can trust, and undo
- Source installs now update from **published releases** by default (Settings → Privacy → Update from),
  not from every change on `main`. The downloaded code must carry the release's version, or it's refused.
  Developers can opt into the `main` channel.
- Every source update first backs up the current version and puts it back if applying fails halfway (disk
  full, a locked file). If the updated COre then fails to start twice in a row, it restores the previous
  version automatically and tells you. This works even when the new version can't load at all, thanks to a
  small bootstrap (`boot.js`) that updates never replace.
- After a rollback, packages are reinstalled only if the failed update had changed them.

### Your data is never overwritten
- A damaged `config.json`, `state.json`, `memory.json` or `notes.json` (a hand-edit typo, a disk problem) is
  now kept as `<file>.corrupt-<time>`, and COre tells you where. Before, it was silently replaced, losing
  settings, API keys, memories or notes.
- Memory keeps a `.bak` of the previous good file and skips invalid entries. Notes are written atomically.

### Fixes
- Messages arriving from a window while it closes (during restart or quit) no longer throw errors in the
  main process.

### Calendar you can rely on
- Recurring events now show (daily, weekly on chosen days, monthly like "2nd Tuesday" or "last Friday",
  yearly), with `COUNT`/`UNTIL`/`INTERVAL`, cancelled occurrences (`EXDATE`) and moved occurrences.
  Before, a weekly meeting only appeared on the day of its very first occurrence.
- Event times are read in their own time zone (with daylight-saving), including Outlook's Windows zone
  names. Before, a 09:00 meeting in another zone showed at 09:00 local time.
- The private calendar link is stored encrypted like API keys (an existing plain-text link is moved over
  automatically), is never shown again in Settings ("Saved (hidden)" with Remove), and can't leak into the
  chat, the brain or logs through error messages.

### A sturdier brain (same brains, better behaved)
- Watchdogs on every provider: one that doesn't start answering within 90 s, or goes silent for 45 s
  mid-answer, is abandoned (configurable via `brain.timeouts`). If nothing was said yet, the next brain in
  your chain takes over. Before, a stalled provider could hold a turn for four minutes.
- An answer that breaks off midway keeps what was already said, says why, and offers **Continue the
  answer** instead of discarding everything.
- Stopping a reply yourself is no longer counted as a provider failure.
- Per-provider health (successes, failures, last error, typical time to first word) appears in Copy diagnostics.
- Conversation history for Gemini/Groq/OpenRouter/Ollama is bounded by size as well as count, so long pastes
  can't overflow small local models. Ollama keeps the model loaded between turns instead of reloading it.

### Memory that stays consistent
- A new fact about the same thing replaces the old one instead of contradicting it ("lives in Bandung"
  supersedes "lives in Jakarta"; favourites are per thing). The old value is kept in the fact's history and
  COre says "🧠 Updated: … (was: …)". Detection is deliberately conservative: only facts clearly about you.
- Project facts: `[[remember #Tower the client wants a glass facade]]` is kept per project and comes up when
  that project is mentioned.
- Every fact records when and where it came from (voice, chat, or you).
- Edit facts in place in the chat's memory panel (✎), next to Forget. Hover a fact to see its date, source
  and earlier wording.

### Problems are no longer silent
- If something unexpected breaks inside COre, it now says so once in the chat (and tints the orb if it keeps
  happening) instead of only writing to the crash log.

## 10.3.0 — New look, fewer loose ends
- New brand: a logo made of smoke filaments, new app and tray icons, a wordmark where the orb is the "O",
  README banner, social preview, promo images for every major format, and a brand guide (docs/BRAND.md).
- Fixed: hiding COre left its helper clones floating on screen; helpers now hide and reappear with it, and a
  helper made while COre is hidden stays hidden too.
- Fixed: "Hey COre" or the talk hotkey while COre was hidden listened with no visible orb; COre now
  reassembles first.
- Fixed: quitting or restarting (including after an update) while helpers were working left their Claude
  processes running in the background.
- Fixed: unplugging the monitor COre lived on (or dropping the resolution) could leave it off-screen; it now
  comes back to a visible spot.
- Fixed: Reset kept your saved notes. It now forgets them along with memory and history.
- The tray tooltip now tells you when hands-free is listening for "Hey COre".
- Two small lists no longer grow forever in sessions that run for weeks.

## 10.2.0 — A voice with feelings
- Emotion-driven voice: when COre's mood changes, its voice follows. It speaks a little faster and brighter
  when excited or happy, slower and lower when sad, softer when calm. The chat text stays in step.
- Re-checked the original voice bugs with the real Claude and the real neural voice: an 8-sentence reply
  was spoken in full, each sentence started within about 0.1 s of the last, and the text reveal matched
  every sentence's audio length.
- Debug logging (`CORE_DEBUG=1`) now shows brain tags, pointing corrections and voice timing.

## 10.1.0 — Tested with the real Claude
- First full test against real Claude (not a stand-in). Notes, skill lookups, helper clones and screen
  pointing all worked; pointing landed within a few pixels of the target.
- COre is now visibly expressive with Claude: replies come with fitting body language (a wave for good
  morning, a laughing smoke face after a pun, a shrug for "who knows", counting to three for three tips).
  Before, Claude rarely used its gestures.
- More automatic gestures when the brain doesn't pick one: "three tips" counts to three, "hard to say"
  shrugs, jokes and puns get a flourish.
- Skills now use the system network settings (proxy and certificates), so weather and calendar work behind
  corporate proxies.
- Helper results in the chat no longer repeat their spoken summary.
- A real point no longer fights with a "point right" gesture sent at the same time.

## 10.0.0 — Release
- Full audit across every system at once (chat, voice, gestures, shapes, skills, helpers, hands-free,
  settings), in the real app and in the packaged build. No page errors, an empty crash log, and about 1% CPU
  in total while idle.
- New README covering everything COre can do, privacy, settings and development.
- Release notes attached to the GitHub release; optional code signing for the Windows installer (add
  `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` repository secrets).
- Bugs found and fixed on the way to 10.0.0: a cough could pass as a wake phrase; the first watch-mode offer
  could be swallowed; a skill follow-up could cut the previous reply's chat text; a plugin hint could echo back
  as a tag; a finished helper lost its colour; drags with a fast release weren't detected as tosses.

## 9.0.0 — Polish
- Themes: pick COre's smoke colour: Emerald (classic), Ice, Ember, Violet, Gold, Rose or Moonlight. It
  applies instantly.
- Performance profiles: Battery saver, Balanced or Best quality, all with one choice.
- Reply language: COre can always answer in the language you pick (Bahasa Indonesia, English, Japanese…),
  whatever language you type or speak in.
- Accessibility: reduce motion (follows Windows' setting by default: no fidgets, calmer drift, no
  speaking shiver), larger chat text, and captions on or off.
- Local crash reports: problems are written to COre's own logs folder (never uploaded), included in "Copy
  diagnostics", and one click away in Settings → Maintenance.
- First-run tour: on the first launch COre waves, points at the chat, makes a smoke heart and shows you
  around in five short lines (replay it from the tray or Settings).

## 8.0.0 — Skills
- COre can now do things, not just talk: take and look up **notes**, set **timers**, tell you the
  **weather** (free Open-Meteo, no key; set your city in Settings → Skills), **control music**
  (play/pause/next/previous/volume), **open apps** from a safe list (Spotify, VS Code, calculator,
  settings, terminal…), offer a **web search**, and read your **calendar** from a private ICS feed link.
- Lookups come back into the conversation: COre says "one moment", checks, then tells you the answer.
- Plugins: drop a small JSON file in COre's data folder → `skills/` to add search-style skills, e.g.
  `{"name": "wiki", "description": "search Wikipedia", "url": "https://en.wikipedia.org/wiki/Special:Search?search={q}"}`.
- Safe by design: nothing runs a command made from the model's words (apps and media keys are fixed
  lists), new pages open only when you click, plugins are data (https links), not code, and every skill
  can be switched off in Settings → Skills.

## 7.0.0 — Screen partner
- Watch mode: when an error dialog, crash report, failed install or "(Not Responding)" window appears,
  COre glows, mentions it, and offers a **Take a look** button in the chat. It only reads window titles
  to notice this; a screenshot is taken only when you click. Rate limited (one offer a minute, the same
  problem at most every 10 minutes), quiet while you're talking to it, and switchable in Settings → Privacy.
- Smarter pointing: when COre points at something on a screenshot, the smoke finger snaps onto the nearest
  button, icon or label instead of landing next to it.
- Multi-monitor: summon COre with a hotkey on another screen and it reassembles there, so it can point
  at what you're looking at (Settings → Look → Move to the screen I'm using).

## 6.0.0 — Hands-free
- "Hey COre": an optional wake phrase, detected entirely on this PC (Settings → Voice, or tray →
  Hands-free). A cheap sound detector only passes short phrases that follow a pause to the local speech
  model, so ordinary conversation is never transcribed and nothing leaves the computer. Say
  "Hey COre" and talk, or say it all at once: "Hey COre, what time is it?"
- Barge-in: with hands-free on, just start talking while COre speaks; it stops and listens (echo
  cancellation keeps its own voice from triggering this).
- Hold to talk: press and hold the orb, speak, let go to send.
- Talk hotkey mode: "stops when I pause" (as before) or "press again to send" for long thoughts.
- Conversation mode: COre listens again for a few seconds after each spoken reply, so a back-and-forth
  doesn't need the hotkey every time.

## 5.0.0 — Many COres
- Helpers: COre can split off up to 3 helper copies that work on tasks in parallel (research from what it
  knows, drafting, planning, writing code) while you keep talking to COre itself. Ask for several things at
  once, or type `/clone <task>` in the chat.
- Meiosis split: COre pushes apart in a burst of smoke and the helper condenses out of it, then drifts to
  its own spot. Clicking a finished helper (or `/merge`, or tray → Call helpers back) merges it back in.
- No overlap: each helper picks the nearest free spot that covers neither COre, the chat nor another
  helper. Each has its own colour (cyan, amber, violet), its own voice and pitch, and its own separate
  conversation, so their contexts never mix.
- One voice at a time: helpers wait for the floor and only speak (a one-sentence summary) while COre is
  quiet. COre always has priority, and starting to talk to COre stops a helper mid-sentence. Full results
  appear in the chat, marked with the helper's name and colour.
- Light: helpers use a smaller orb, fewer particles and a lower idle frame rate, and their brain process
  stops as soon as the task is done.

## 4.0.0 — Companion presence
- Idle chit-chat: after a quiet while (25 min by default) COre starts a short, relevant conversation on
  its own: the time of day, what you seem to be working on, something it remembers, a fun fact or a game.
  It's polite about it. It only speaks when you're at the computer but paused (never mid-typing, never
  when you're away), never in quiet hours (22:00–08:00 by default), at most 6 times a day, and it waits
  twice as long each time you ignore it.
- Touch it: pet COre (slow strokes) and it hums and glows happily, sometimes with a smoke heart; tickle it
  (quick wiggles) and it giggles into a laughing face; poke it (quick double click) and it jumps, and gets
  annoyed if you keep going; toss it (fling while dragging) and it flies, spins and lands where it went.
  Now and then it says something about it (can be turned off).
- Games: tray → Play a game (trivia, riddle, 20 questions), or just ask. COre hosts and keeps score.
- New settings: chit-chat on/off, quiet time, quiet hours, talk-back reactions.

## 3.0.0 — Shape-shifting
- COre's smoke can form shapes: emoji faces (laugh, smile, sad, wink, surprised, cool, angry), heart,
  check, cross, question/exclamation marks, star, sun, moon, music note, light bulb, Zzz, arrows,
  infinity, clock, lightning, ring, and any one to three letters or digits ("42", "OK").
- Shapes come with matching voice sounds through the robot voice: a giggle with the laughing face, a hum,
  a sigh, a gasp, a ding, a buzz or a thoughtful "hmm". The next sentence waits for the sound.
- `[[form NAME]]` tag for the brain; a "haha" in a reply makes COre laugh in smoke on its own.
- Cheap by design: each shape is drawn once into 2,048 target points and uploaded as one tiny texture;
  the smoke simply flows to them.

## 2.0.0 — Body language
- 30 gestures, all made from COre's own smoke arms and body, so they cost nothing extra on the GPU:
  wave, thumbs up/down, shrug, count to five, clap, facepalm, point up/down/left/right, beckon, stop,
  OK, peace, rock, heart hands, think, salute, fist pump, celebrate, juggle, hug, magic, flex, bow,
  nod, shake, spin and bounce.
- Smoke hands now have individually moving fingers (each finger curls and straightens).
- COre picks gestures while it talks (`[[gesture NAME]]`), and when it doesn't, adds one that fits
  what it's saying now and then: a wave for hello, a shrug for "no idea", a count for "second…".
- Idle fidgets: every so often COre juggles, flexes, ponders or waves on its own.

## 1.0.0 — Real app
- Settings window (tray → Settings…, or ⚙ → All settings… in the chat): every option in one place,
  grouped into General, Look, Voice, Brain and Privacy. Changes apply instantly where possible; the
  few that need a restart say so and offer a Restart button. Values are checked before they're saved,
  and shortcut clashes are refused.
- Start COre when you sign in (optional).
- Maintenance: check for updates, copy diagnostics, open the data folder, restart, reset (forget settings,
  memory and history; downloaded models stay) and uninstall.
- Windows installer: `COre-Setup-<version>.exe`, built automatically on GitHub for every release, with
  Start-menu and desktop shortcuts, a choice of folder, and a proper uninstaller in Windows' Apps list.
  Installed copies update themselves from GitHub Releases; source copies keep updating from `main`.

## 0.5.0 — Harmony & glass
- Fixed flicker while dragging and while idle: COre's window is now a fixed-size square that only moves
  (moving doesn't redraw; resizing did). It resizes once when a drag or far point starts and once after.
  Measured: 0 resizes during 15 s of idle life, 2 for a whole drag.
- Fixed a drag that could get stuck (no drop) when the window resized under the pointer.
- The chat hides while you drag COre and reappears under it when you drop.
- Fixed replies going quiet after a few sentences: typed replies are now spoken in full (code is skipped).
- Voice ⇄ text harmony: each spoken sentence's words appear over the real length of its audio, typed or
  spoken questions alike.
- Chat redesign: 340 px translucent glass, shows just the latest exchange (⌃ expands history), fades almost
  away after 7 s idle and returns on hover, typing or when COre talks.

## 0.4.1 — Alive and quick
- New orb animations: assembles from scattered smoke on start and when shown, dissolves when hidden,
  shockwaves on click / drop / notifications / reminders, an inhale when it starts listening, a faster spin
  while thinking, and small idle behaviours (a spin, a hop, a ripple) every 25-45 s.
- Much faster voice: 4-bit voice model (~3x quicker to render), tiny first spoken phrase, speech recognition
  warmed up in the background (the first spoken question no longer waits for it to load).
  Measured on a slow 4-core cloud machine: typed question to first spoken word 4.1 s -> 1.7 s; spoken question
  (from end of speech) 7.3 s -> 3.6 s.
- Instant feedback: typing dots in the chat and a "got it" pulse the moment you stop talking.
- Fixes: offered action buttons no longer accumulate forever; the window makes room for the scattered smoke
  while COre assembles or dissolves.

## 0.4.0 — COre gets a memory and a life
- Long-term memory across conversations (works with every brain), managed in ⚙ → Memory.
- Reminders and timers that survive restarts, with voice, glow and a Windows notification.
- One-click actions: open a website or copy text, only when you click.
- Clipboard awareness ("explain what I copied").
- Moods: the smoke changes colour and motion with the feel of the reply.
- Presence: the orb notices your cursor; a built-in greeting on the first launch of the day.
- Fixes: Electron 45's clipboard API is asynchronous (clipboard content now reaches the brain); a finished
  spoken answer interrupted mid-speech stays complete in the chat; unclosed `[[` text is no longer dropped;
  the history panel no longer grows without limit.

## 0.3.1
- Screenshots go to Claude inline; open-window list; voice and chat text in sync; settings Back button;
  drag fixes; staggered start-up.

## 0.3.0
- Persistent Claude session (replies start in about a second); crash-free restarts; voice latency work.
