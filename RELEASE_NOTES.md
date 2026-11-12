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
synthesis, embeddings). No additional downloads are required. Existing installations update automatically once
this release is published.

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
