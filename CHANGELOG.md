# Changelog

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
