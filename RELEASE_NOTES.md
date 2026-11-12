# COre 12.1.1

COre 12.1.1 adds tutorials taught by COre itself, so new users can learn every major feature inside the
application.

## Highlights

- **Interactive tutorials.** Type `/tutorial` or choose **Tutorials** from the tray menu. COre teaches five short
  lessons in the chat, with its voice and gestures:
  1. Talking with COre (typing, voice and screen questions)
  2. What COre remembers
  3. The knowledge vault and Obsidian
  4. Working on the desktop (approved tasks and suggestions)
  5. Making COre yours (settings, command center, diagnostics)
- **Learning by doing.** Steps that ask you to try something wait until you have done it. Say *next* to skip a
  step or *stop* to leave; progress is saved and resumes where you left off.
- The first-run tour now ends by offering the tutorials.

## Installation

| Platform | Asset |
|---|---|
| Windows 10/11 (x64) | `COre-Setup-12.1.1.exe` |
| Android | `COre-android-12.1.1.apk` (pair from Settings → Phone) |

The Windows installer includes the Cortex knowledge engine and all local models. No additional downloads are
required. Existing installations update automatically once this release is published.

Verify downloads against `SHA256SUMS.txt`.

## Known limitations

- The installer is not code-signed. Windows SmartScreen or antivirus software may show a warning.
- Tutorials are in English.

## Verification

Released through the gated release workflow: unit and end-to-end tests on Windows and Linux (including a
tutorial run in the application), packaged-application self-test, silent install and uninstall, the
installed-files check with the bundled Cortex engine, and the installed-application acceptance test.

Full change history: [CHANGELOG.md](https://github.com/rawsushies/core-ai-companion/blob/main/CHANGELOG.md)
