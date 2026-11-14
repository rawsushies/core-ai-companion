# COre 13.0.0

COre 13.0 is the first release of **trustworthy autonomy**: you approve a mission once and COre carries it out on
your desktop, checking its own work and asking only when a step is high-impact. Your phone becomes a remote for
it, and the bundled memory engine moves to **Cortex 2**.

## Highlights

- **Missions you approve once.** Type `/autopilot` and a goal. COre shows what it may touch (folders, apps,
  websites); you approve once. It plans subgoals, verifies each one on disk, retries once, then asks you. The
  report shows every subgoal with its evidence.
- **A safety policy on every step.** Routine work inside the approval runs without asking. Sending, deleting,
  installing and anything outside the approval ask first. Payments and security settings always ask. Passwords
  and COre's own safeguards are refused.
- **Resistant to hidden instructions.** A recipient, website or command that came from a document, web page or
  screen text needs your approval, however it is phrased.
- **Undo, even after a crash.** `/mission undo` restores every file a mission changed.
- **Stop instantly** with Esc, the emergency hotkey (Ctrl+Alt+Shift+X), `/mission stop`, the command center or
  your phone.
- **Your phone as a remote.** See the running mission, approve a waiting step with your fingerprint or face,
  decline, or stop the mission. Notifications tell you when COre needs an answer.
- **Cortex 2 memory.** Answers cite their sources; COre's conversations are archived in your vault; decisions
  the model proposes wait in Cortex's review list until you accept them.

## What has been verified, and what has not

COre's autonomy is measured, not assumed. This release has been verified with **scripted and simulated reasoning
and on Linux and Windows CI**:
- the safety policy (including 25,000 random decisions)
- crash recovery with real process kills
- stop timing in the real app
- the phone protocol, with a scripted phone client

It has **not yet** been measured with a real AI model on your own PC, and it has not been tried on a real phone,
so **no autonomy level is claimed**. The 100-task evaluation on a real machine comes next.

## Installation

| Platform | Asset |
|---|---|
| Windows 10/11 (x64) | `COre-Setup-13.0.0.exe` |
| Android | `COre-android-13.0.0.apk` (pair from Settings → Phone) |

The Windows installer includes the Cortex 2 knowledge engine and all local models. No additional downloads are
required. Existing installations update automatically once this release is published.

Verify downloads against `SHA256SUMS.txt`.

## Known limitations

- The desktop agent and missions are off until you turn them on in Settings → Agent ("Let COre operate this PC").
- On small screens (1366×768 or less) a fifth specialist window may not fit; COre then answers itself.
- Phone notifications arrive while the COre app is open or recently in the background (Android pauses apps after
  a while).
- The PC trusts the phone's fingerprint check; a key bound to the phone's secure hardware is planned.
- The installer is not code-signed. Windows SmartScreen or antivirus software may show a warning.

## Verification

Released through the gated release workflow:
- unit and end-to-end tests on Windows and Linux
- packaged-application self-test
- silent install and uninstall
- the installed-files check with the bundled Cortex engine
- the installed-application acceptance test

Full change history: [CHANGELOG.md](https://github.com/rawsushies/core-ai-companion/blob/main/CHANGELOG.md)
