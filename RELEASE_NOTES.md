# COre 11.0.0

The biggest COre update yet: a redesigned chat, an agent that can work your desktop, an Android app, cards beside
the orb, backups and Google-synced memory. Everything new is off or harmless by default.

## Install

- **Windows:** download `COre-Setup-11.0.0.exe` and run it. Windows may warn that the installer is unsigned: choose
  *More info* → *Run anyway*.
- **Android:** download `COre-android-11.0.0.apk` on your phone and open it. Allow installing from your browser
  when asked. In COre on your PC: Settings → Phone → Pair a phone.
- Checksums are in `SHA256SUMS.txt`.

## What's new

- **New chat, built to the brand kit:** one clear panel with a solid frame, COre's mark and status, grouped
  bubbles, and quick settings as cards.
- **Desktop agent (off by default):** turn it on in Settings → Agent and type `/do` + a task. COre clicks and types
  one step at a time, asks before every step, and Esc stops it.
- **Cards beside the orb:** now playing with album art, synced lyrics, timer countdowns, weather, calendar, and
  live progress when several cores work together.
- **Instant answers:** time, date, media keys and "show the lyrics" answer in a fraction of a second, without the
  brain.
- **Phone:** pair with a QR code, chat end-to-end encrypted over your Wi-Fi, use media buttons. The new Android app
  also works away from home with Gemini, and keeps what COre knows about you.
- **Backups and cloud memory:** back up to any folder (OneDrive / Google Drive / Dropbox work as cloud backup), with
  optional encryption. Optionally sync COre's memory with your Google Drive's private app folder (needs your own
  Google OAuth client: see `docs/dev/CLOUD.md`).
- **Lighter:** no drawing at all while hidden or locked (53% → 1.7% CPU measured), fewer particles while idle,
  battery caps.
- **Fixes:** many, including phone keys kept out of backups, a phone clock-skew loop, scrolling over chat gaps, and
  the phone server stopping when a card closed.

Full details: `CHANGELOG.md`.

## Known limits

Not yet verified on real hardware: the desktop agent's Windows input, Windows song reading, a real phone on real
Wi-Fi, and Google sign-in with a real account.
