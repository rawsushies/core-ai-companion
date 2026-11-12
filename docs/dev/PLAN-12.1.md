# Plan: COre 12.1 — human-speed responses, one design, a tidy repository

Status: draft, 2026-11-12. Follows the 12.0.0 release.

## Goal

1. **Speed:** COre answers as fast as a person in conversation, or faster. People leave a gap of roughly
   200–300 ms between turns; COre should react audibly within that and start its real answer soon after.
2. **Design:** every window and card uses the chat's "invisible" design (no fill, your screen shows
   through; solid frame, dividers and bubbles so it stays readable over anything).
3. **Repository:** one version everywhere, a README built on the brand kit, docs that match the product.

## Targets (measured, not assumed)

| Moment | Today (estimate, to be measured) | Target |
|---|---|---|
| You stop talking → COre reacts (sound/gesture) | ≥ 1.5 s | **≤ 300 ms** |
| You stop talking → first word of the answer | 2–4 s | **≤ 1.0 s** fast brain, ≤ 1.5 s Claude |
| Typed Enter → first words on screen | 0.5–3 s | **≤ 400 ms** fast brain |
| Instant answers (time, media, lyrics) | ~100 ms | **≤ 100 ms** |
| You interrupt → COre stops speaking | — | **≤ 150 ms** |
| Hotkey → chat visible | — | **≤ 100 ms** |
| Settings / command center open | — | **≤ 300 ms** |

## Phase 1 — Measure first

- A latency tracer in the main process: marks for speech end, transcript final, brain first token, first audio
  out, window shown, interrupt → silence. Per-turn timeline in the audit log; p50/p95 in `/diagnostics`.
- `npm run benchmark:latency`: recorded voice clips through the real speech recognizer, real brain (Groq,
  Gemini) and real voice; typed turns; window open times. Results in `docs/BENCHMARKS.md`.
- Budgets checked in CI (e2e on Linux, Windows job for window and UI Automation times).

## Phase 2 — Voice pipeline

- **Streaming recognition:** transcribe while you speak (partial passes every ~0.7 s in the worker), so
  the final transcript needs only the last fragment once you stop.
- **Adaptive end-of-turn:** 600 ms of silence today. Shorten to ~300–350 ms when the partial transcript is
  a complete sentence. Keep it longer for hesitations ("um", trailing "and…").
- **Instant acknowledgement:** at end of turn, an orb gesture plus a short pre-rendered sound or word when the
  answer will take longer than ~600 ms (Jev's complexity estimate). Pre-rendered at start-up, so it plays at
  once. Nothing extra for instant answers.
- **Speculative start:** send the request on a stable partial transcript; cancel and resend only if the final
  transcript changes its meaning.
- **Faster first audio:** the first spoken chunk is the first clause (6–10 words), not the first sentence.
  The voice model stays warm, and frequent lines are cached.
- **Barge-in:** stop playback on the first frames of your voice (≤ 150 ms), then listen.

## Phase 3 — Brain and context

- Quick conversational turns go to the fastest healthy provider by measured first-token time (the router
  already tracks latency); deep turns keep the strong model. Claude keeps its warm session.
- Fetch memory recall, the desktop situation and the app profile in parallel. Fetch the desktop situation
  only when the question needs it. Use a smaller prompt for quick turns (tighter memory budget, cached system
  prompt).
- Begin speaking as soon as the first clause streams in. Never wait for the full reply.

## Phase 4 — App responsiveness

- Keep the chat, settings and command center windows pre-created and hidden, so they show in under 100 ms.
- Start-up: defer non-essential services (updater, phone, automations) until after the first frame.
  Measure cold start.
- Renderer: batch IPC updates per frame, virtualize long transcripts, no layout thrash. The orb's GPU
  budget stays within today's CPU numbers.

## Design — one "invisible" design system

- Extract the chat's tokens and components (shell, frame, dividers, halo text, solid bubbles and cards,
  icon buttons, inputs, toggles) from `src/renderer/dock/dock.css` into `src/renderer/brand.css`.
- Apply it to the windows and cards still using solid backgrounds:
  - settings
  - command center
  - agent monitor and its highlight
  - helper panels
  - the orb's cards (glance, now playing, timers, task progress)
  - the vault/suggestion messages
  - the phone app, where it fits a full-screen phone UI
- Readability over anything: each window is screenshot-tested on a light, a dark and a busy wallpaper in
  e2e, with a contrast check of text against its backing (frame, bubble or halo).
- Brand kit rules (docs/BRAND.md): Void/Smoke/Emerald/Mint/Ink/Muted only, Inter Display for headings,
  Inter for body, JetBrains Mono for commands. One Emerald accent per view.

## Repository

- **One version:** `package.json` is the source. `npm run check` fails if any of these disagree with it:
  `mobile/package.json`, the Android versionName, `RELEASE_NOTES.md`, the newest CHANGELOG heading, or the
  README.
- **README:** rewritten around the brand kit (banner, palette, real renders). It covers:
  - what COre is now
  - install (12.x installer with Cortex and models included, Android APK)
  - first start (vault, Obsidian)
  - brains and free keys
  - privacy
  - the knowledge layer
  - develop
  It drops the stale notes about broken old installers and Claude being the default brain.
- **README as a piece of the brand, not a manual:** designed like the promo material (banner, real renders,
  short punchy sections, the dark/emerald look), with its own story structure rather than a feature dump.
  Practical install and develop details move to compact sections lower down or to docs/.
- **Docs:** user docs in `docs/`, developer docs in `docs/dev/`, finished audits and research in
  `docs/dev/archive/`. ROADMAP stays the single progress page; CHANGELOG has no leftover "Unreleased" parts.
- **Housekeeping:**
  - remove unused files (e.g. `assets/v0.2-preview.png`)
  - move the two promo videos (~27 MB) out of the source tree into the brand kit's release assets
  - `vendor/` stays build-only

## Promo material (after the update ships)

- Remake the promo video: calm and cinematic, not bouncy. Slow camera, real smoke renders, timing that
  follows the voice.
- Remake the demo video: not bland. Show a real story (the user talks, COre reacts at human speed, works the
  desktop, remembers through the vault, shows up in Obsidian), with the measured response times on screen.
- Refresh the stills (hero, agent, phone, cards, features) from the 12.1 design. Promo assets live in the
  release, not the source tree.

## Order and acceptance

1. Phase 1 lands first. Every later change is accepted only when the benchmark shows it moved a target.
2. Phases 2–4 and Design in parallel branches of work, each with its tests.
3. Repository last, so the README describes the final 12.1.
4. Release 12.1.0 through the gated release (installer check, real-provider run, all CI).
5. Promo material from the shipped app.

Done means the targets table filled with measured p50/p95 values that meet the targets, every window passing
the readability screenshots, `npm run check` enforcing one version, and CI green on Linux and Windows.

## Needs the user's PC

Real microphone latency and barge-in feel, Claude CLI timings, and how the invisible windows look on your own
wallpaper: a short checklist (`/diagnostics` shows the measured timings) to run after installing 12.1.
