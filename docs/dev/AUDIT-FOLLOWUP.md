# Follow-up audit (after M-019)

What changed since the first audit (`AUDIT-2026-11-09.md`), what's still wrong, and what's still missing.
Every number below was measured in this environment (Linux, Xvfb, software rendering) unless marked otherwise.

## Fixed or added since the first audit

| Area | Before | Now |
|---|---|---|
| Releases | Every published installer incomplete (racing publishers) | Tag-only, draft, gated release workflow; CI on Linux + Windows |
| Updates | No rollback, followed `main` | Release channel, backup/rollback, crash-loop rollback via `boot.js` |
| Data | Corrupt files overwritten | Quarantined; backups to any folder (cloud-synced works), encrypted option, restore with snapshot |
| Chat UI | Panel; then bubbles the user disliked | One clear panel with a solid frame, header with mark and status, grouped Smoke bubbles, card settings |
| Brand | Old green, greys, "CORE" in subtitles | Brand palette and fonts in every window; real mark used; caption fixed |
| Speed | Every request went to the brain | Time, date, media keys, lyrics card answered locally in 40–200 ms |
| CPU/GPU | Safe-graphics idle 173% of a core; hidden COre kept rendering | Idle 37–53%; hidden/locked 1.7%; ambient 4 fps when away; battery caps |
| New | – | Glance card (now playing, synced lyrics, short cards), phone companion, Meiosis Mode, project reading, approved file changes |

## Still wrong (known issues)

1. **Software rendering is still expensive.** In safe graphics mode the idle orb costs about half a CPU core,
   because every frame is drawn by the CPU. On a real GPU this is GPU time instead, which is not measured here.
   Next step: draw fewer particles while idle, not only fewer frames.
2. **Voice start is about 1 s on CPU for model replies.** Kokoro's first audio chunk dominates the time to first
   speech (warm Claude: about 0.7 s to the first text, 1.7 s to the first audio). Quick answers are now pre-rendered
   and cached (0 ms; a fresh short phrase takes about 300 ms), so only model replies still wait.
3. **Click-through gaps only work on Windows and macOS.** On Linux the whole chat window takes the mouse. Since the
   M-015 redesign the gaps sit inside the panel frame, so this matters less. A Linux fix (`setShape`) would also
   clip the frame, so it's left as is.
4. **The phone page is served over plain HTTP.** Messages are end-to-end encrypted, but someone who controls the
   Wi-Fi when the page loads could tamper with it (documented in `PHONE.md`).
5. **Windows media reading (now playing, lyrics) is untested on real Windows.** The script uses the documented
   WinRT API, but nobody has run it there yet.
6. **On Linux without a keyring**, "encrypted" secrets fall back to plain text (Electron limitation).
7. **Lyrics timing** depends on the player's reported position. Some players report rarely, so lines can lag a
   little.

## Fixed in this pass

- A phone message saying "look at this" could trigger an automatic screenshot. Remote messages never capture the
  screen now.
- The cloud-folder test failed on Windows (Unix path in the test). CI is green on Linux and Windows again.

## Still missing

- **Approvals from the phone.** Reviewing and applying file changes from the phone needs the same diff card and
  confirmation as the desktop. Not built on purpose.
- **Remote access away from home.** Only the local network is supported. Remote use needs an end-to-end-encrypted
  relay (design in `RESEARCH-PHASE5-6.md`).
- **Native Android app.** It would remove the plain-HTTP page limit. The web app proves pairing and revocation first.
- **Windows UI Automation and Revit.** Research only. Archicad is a read-only proof of concept against a mock.
- **Album art in the glance card.** Media sessions provide a thumbnail; showing it needs a safe image path.
- **Cloud backup without a sync app** (direct Google Drive or OneDrive API). Deliberately not built: OAuth and
  tokens add risk, and a synced folder already works.

## Not verified at all

- A real phone on a real Wi-Fi, and the Windows firewall prompt.
- The installer-based release updater, until a gated release is published (needs release approval).
- Archicad, Revit and UIA against the real applications.
