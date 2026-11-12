# Release descriptions

Professional descriptions for every GitHub release, ready to paste (Releases → the release → Edit). The
current release uses `RELEASE_NOTES.md` automatically. Releases before 11.0.0 were produced by an earlier
pipeline and carry incomplete assets; their descriptions say so.

---

## v12.1.1

Paste the contents of [RELEASE_NOTES.md](../../RELEASE_NOTES.md).

---

## v12.1.0

```markdown
# COre 12.1.0

COre 12.1.0 makes conversation substantially faster, applies one interface design throughout the application,
and verifies the complete installer, from first launch to multi-device synchronisation, on Windows.

## Highlights

- **Faster voice responses.** COre reacts within 200 ms of the end of speech (previously 600 ms). Speech
  recognition starts during natural pauses, English uses a faster on-device recogniser, and a completed sentence
  ends the turn sooner. COre's own processing before the model responds fell from about 1.2 s to 350 ms.
- **Faster everyday interaction.** Simple questions bypass specialist routing, context is gathered in parallel,
  and the settings and command center windows open instantly.
- **Consistent interface.** Chat, settings, command center, monitor and overlays share one transparent design,
  validated for legibility on light, dark and busy wallpapers.
- **Synchronisation visibility.** `/vault` reports Syncthing status, connected devices and conflict copies.
  Conflicts are flagged in answers and offered for review; COre never resolves them automatically.
- **Response-time diagnostics.** `/diagnostics` reports measured response times by turn type.

## Installation

| Platform | Asset |
|---|---|
| Windows 10/11 (x64) | `COre-Setup-12.1.0.exe` |
| Android | `COre-android-12.1.0.apk` (pair from Settings → Phone) |

The Windows installer includes the Cortex knowledge engine and all local models (speech recognition, speech
synthesis, embeddings). No additional downloads are required. Superseded by 12.1.1.

Verify downloads against `SHA256SUMS.txt`.

## Requirements

- A language model provider: Claude Code (signed in), or a free API key for Gemini, Groq or OpenRouter, or a
  local Ollama model.
- Obsidian and Syncthing are optional.

## Known limitations

- The installer is not code-signed. Windows SmartScreen or antivirus software may show a warning.
- Time to the first spoken word depends on the model provider's response time; free tiers may be slower under
  rate limits.
- The faster recogniser is used for English; other languages use Whisper.

## Verification

Released through the gated release workflow. In addition to unit and end-to-end tests on Windows and Linux,
this release was verified on Windows with the real installer: silent installation, first launch, bundled
Cortex, vault creation and registration in Obsidian, remember and recall, and two installations synchronising
knowledge through Syncthing in both directions. Obsidian opening the COre vault and the bundled Cortex reporting
synchronisation conflicts are also verified.

Full change history: [CHANGELOG.md](https://github.com/rawsushies/core-ai-companion/blob/main/CHANGELOG.md)
```

---

## v12.0.0

```markdown
# COre 12.0.0

COre 12.0.0 introduces desktop automation, a local long-term knowledge layer and proactive assistance.
All new capabilities are opt-in or require explicit approval before acting.

## Highlights

- **Desktop automation.** The agent reads applications through Windows UI Automation, plans each task,
  performs one approved step at a time and verifies the result. Commands run in a Windows AppContainer
  sandbox restricted to user-approved folders.
- **Long-term knowledge layer.** Decisions, lessons and research are stored as plain Markdown in a local
  vault, indexed by the bundled Cortex engine. The vault is compatible with Obsidian and can be synchronised
  between devices with Syncthing. Sync conflicts are preserved and reported, never resolved silently.
- **Situation awareness.** COre can describe the active desktop (windows, dialogs, current project) with a
  source for every statement, and rejects answers that reference items it cannot observe.
- **Proactive suggestions.** Interrupted tasks, overdue items and failed automations are surfaced on request
  (`/suggest`). No action is taken without confirmation.
- **Provider resilience.** Models are selected from each provider's live catalogue and replaced automatically
  when retired or unavailable. Verified against Groq and Gemini.
- **Diagnostics.** `/diagnostics` reports provider health and latency, routing, memory, sandbox and automation
  status without exposing secrets.

## Installation

| Platform | Asset |
|---|---|
| Windows 10/11 (x64) | `COre-Setup-12.0.0.exe` |
| Android | `COre-android-12.0.0.apk` (pair from Settings → Phone) |

The Windows installer includes the Cortex knowledge engine and all local models (speech recognition, speech
synthesis, embeddings). No additional downloads are required, and the application works offline after
installation. Superseded by 12.1.0.

Verify downloads against `SHA256SUMS.txt`.

## Requirements

- A language model provider: Claude Code (signed in), or a free API key for Gemini, Groq or OpenRouter, or a
  local Ollama model.
- Obsidian and Syncthing are optional.

## Security

- Every desktop action requires approval; commands execute in an OS sandbox.
- Retrieved content (files, web pages, notes) is treated as data, never as instructions.
- Conversation history is never imported automatically; the knowledge index remains on the local machine.

## Known limitations

- The installer is not code-signed. Windows SmartScreen or antivirus software may show a warning.
- Some applications expose few controls to UI Automation; COre then uses keyboard input and verifies results
  from saved files.
- Prompt-injection detection is advisory; enforcement relies on approvals and sandboxing.

## Verification

Built and released through the gated release workflow: unit and end-to-end tests on Windows and Linux,
packaged-application self-test, silent install/uninstall, and an installed-files check including a functional
test of the bundled Cortex engine.

Full change history: [CHANGELOG.md](https://github.com/rawsushies/core-ai-companion/blob/main/CHANGELOG.md)
```

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
