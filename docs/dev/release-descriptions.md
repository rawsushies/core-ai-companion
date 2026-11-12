# Release descriptions

Professional descriptions for every GitHub release, ready to paste (Releases → the release → Edit). The
current release uses `RELEASE_NOTES.md` automatically. Releases before 11.0.0 were produced by an earlier
pipeline and carry incomplete assets; their descriptions say so.

---

## v12.0.0

Paste the contents of [RELEASE_NOTES.md](../../RELEASE_NOTES.md).

---

## v11.0.0

```markdown
# COre 11.0.0

COre 11.0.0 adds a desktop agent, an Android companion app, contextual cards and a redesigned chat interface.
New capabilities are disabled by default or require confirmation.

## Highlights

- **Desktop agent (opt-in).** Performs tasks step by step with approval before each action; Esc stops it.
- **Android companion.** Pairs over the local network with end-to-end encryption; works standalone with Gemini
  when away from the PC.
- **Contextual cards.** Now playing with artwork and synced lyrics, timers, weather, calendar and task progress.
- **Redesigned chat** aligned with the brand guidelines.
- **Instant answers** for time, date and media controls without a model round trip.
- **Backups** to any local or cloud-synchronised folder, with optional encryption.
- **Optional cloud memory** in the user's Google Drive application folder (`drive.appdata` scope only).
- **Lower resource use**: rendering pauses while hidden or locked.

## Installation

| Platform | Asset |
|---|---|
| Windows 10/11 (x64) | `COre-Setup-11.0.0.exe` |
| Android | `COre-android-11.0.0.apk` |

Verify downloads against `SHA256SUMS.txt`. The installer is not code-signed. Superseded by 12.0.0.
```

---

## v10.2.0

```markdown
# COre 10.2.0

Emotion-driven speech: voice rate and tone follow the companion's mood, with the transcript kept in sync.
Verified against Claude and the neural voice for multi-sentence replies.

> **Legacy release.** Built before the gated release pipeline; the release contains only a partial asset
> (`.blockmap`) and cannot be installed or updated from. Use the latest release instead.
```

## v10.1.0

```markdown
# COre 10.1.0

First validation against the production Claude model: notes, skill lookups, helper instances and on-screen
pointing verified. Body language is now consistently applied to replies.

> **Legacy release.** Built before the gated release pipeline; installer only, without update metadata
> (`latest.yml`), so installed copies cannot update. Use the latest release instead.
```

## v10.0.0

```markdown
# COre 10.0.0

Release candidate after a full-system audit (chat, voice, gestures, skills, helpers, hands-free mode,
settings) in the development and packaged builds. Optional code signing support for the Windows installer.

> **Legacy release.** Built before the gated release pipeline; the release contains only a partial asset
> (`.blockmap`). Use the latest release instead.
```

## v9.0.0 to v2.0.0

Use the matching block. Every one ends with the same legacy note:

> **Legacy release.** Built before the gated release pipeline; assets are incomplete and installed copies
> cannot update. Use the latest release instead.

```markdown
# COre 9.0.0

Personalisation and accessibility: seven colour themes, performance profiles, a fixed reply language,
reduced motion (following the Windows setting) and larger text options.
```

```markdown
# COre 8.0.0

Skills: notes, timers, weather (Open-Meteo), media control, launching applications from an allow-list, web
search and calendar (ICS). Results are returned into the conversation. JSON link-template plugins.
```

```markdown
# COre 7.0.0

Screen assistance: detects error dialogs and unresponsive windows from window titles and offers help;
screenshots are taken only on request. On-screen pointing snaps to the nearest control.
```

```markdown
# COre 6.0.0

Hands-free mode: optional on-device wake phrase ("Hey COre") and barge-in. Only short phrases after a pause
are processed locally; no audio leaves the computer.
```

```markdown
# COre 5.0.0

Parallel helpers: up to three helper instances work on tasks concurrently and merge back on completion,
with non-overlapping placement on screen.
```

```markdown
# COre 4.0.0

Ambient presence: optional, rate-limited conversation starters that respect quiet hours and back off when
ignored; touch interactions on the orb.
```

```markdown
# COre 3.0.0

Shape rendering: the particle system forms emoji, symbols and short text, with matching sound cues.
```

```markdown
# COre 2.0.0

Body language: 30 gestures rendered by the particle system, with articulated hands, chosen automatically
during speech.
```
