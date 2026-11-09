# Changelog

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
