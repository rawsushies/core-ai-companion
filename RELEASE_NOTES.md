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
installation. Existing installations update automatically once this release is published.

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
