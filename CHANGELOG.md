# Changelog

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
