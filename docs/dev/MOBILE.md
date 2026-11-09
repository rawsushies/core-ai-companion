# COre for Android

A real Android app (Capacitor 8.5.3) in `mobile/`. CI builds a debug APK on every change to `mobile/`
(workflow **Android app** → artifact `COre-android-debug`). Install it by downloading that artifact on your
phone, or with `adb install`.

## Two ways to talk

| | With your PC | Away |
|---|---|---|
| When | The PC is reachable on your Wi-Fi | The PC isn't reachable (or not paired) |
| Brain | COre on your PC (Claude and everything it can do) | Gemini, straight from the phone with your own key |
| Knows you | Yes | Yes: the app keeps a copy of COre's memory, refreshed every 10 minutes while connected |
| Extras | Status, media remote, Stop | – |

## Pairing

On the PC: Settings → Phone → **Pair a phone**. In the app: Settings → **Scan QR code** (where the phone's
WebView supports it), or paste the pairing link. Compare the 6-digit code on both screens and click Allow on the
PC. It's the same encrypted protocol as the phone page (see `PHONE.md`). The PC only accepts browser calls from
the app's own origin (`http://localhost`).

## Low and mid-range phones

The orb is a 2D canvas (no WebGL), sized by device class:

| Class | Picked when | Particles | FPS | Resolution |
|---|---|---|---|---|
| Light | ≤ 4 CPU cores or ≤ 3 GB RAM | 180 | 24 | 1× |
| Balanced | ≤ 6 cores or ≤ 4 GB | 320 | 30 | 1.5× |
| Smooth | otherwise | 520 | 30 | 2× |

It draws nothing while the app is in the background or the orb is off screen, and one still frame with reduced
motion. You can override the class in the app's Settings. Polling the PC slows to every 30 s in the background.

## Privacy

Everything stays in the app's own storage on the phone: the pairing key, the Gemini key, the memory copy and the
away-mode chat. In away mode the message, recent away-mode chat and the memory copy go to Google's Gemini API.

## Tested

- Real-app e2e (in CI): the app at its real origin and phone size pairs with the desktop, chats through it,
  receives the memory, then answers through Gemini (mocked) with that memory once the PC stops answering.
- `npx cap add android` + manifest patch run here; the Gradle build runs in CI (no Android SDK in this sandbox).
- Not yet run on a real phone: QR scanning in the WebView, real Gemini calls from the phone, battery use.

## Google account / Drive

Not connected yet. Syncing memory through your Google Drive needs an OAuth client in your own Google Cloud project
(desktop and Android client IDs). The plan is in the follow-up audit; it'll be built once a client ID exists.
