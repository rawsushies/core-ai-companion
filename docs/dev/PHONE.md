# Phone companion

Chat with COre from your phone's browser on the same Wi-Fi. It's off by default (Settings → Phone).

## What the phone can do

- See the chat (your messages and every core's replies) and whether COre is thinking or speaking.
- Send a message, which COre treats like a typed one.
- Stop COre talking.

The phone sends intents only. It can't change settings, approve file changes or run anything, and its messages
never trigger a screenshot ("look at this" from the phone is answered without one). If you shared a project folder,
COre may still read it to answer, read-only, exactly as for a typed message.
Approving proposed file changes from the phone is deliberately not included yet. It would need the same
diff card and confirmation as the desktop.

## How it's protected

| Threat | Protection |
|---|---|
| Someone on the internet | The server answers private-network addresses only (10/8, 172.16/12, 192.168/16, link-local, loopback). Nothing is forwarded or relayed. |
| Someone else on the Wi-Fi reading traffic | Every request and answer after pairing is sealed with a per-phone 256-bit key (XSalsa20-Poly1305 via tweetnacl). |
| Someone else on the Wi-Fi sending commands | Without the phone's key nothing opens. Unknown devices get 401. |
| Replaying a captured message | Each message has a counter that must increase and a timestamp within 2 minutes. |
| A photographed QR code | The pairing secret works once, for 5 minutes. Both screens show a 6-digit code (from SHA-512 of the secret, device id and key) that you compare before clicking Allow. |
| A lost phone | Settings → Phone → Remove. Its key is deleted at once and its next request fails. |
| Keys at rest | Phone keys are stored encrypted with your OS account (safeStorage). The phone keeps its key in the browser's local storage for that site. |

The pairing secret is in the QR code's URL fragment (`#pair=…`). Browsers never send fragments over the
network, and the phone clears it from the address bar after pairing.

## Known limits (honest)

- The phone page is served over plain HTTP on your network, because a local self-signed HTTPS certificate would
  show a browser warning. Someone who **actively controls your Wi-Fi at the moment you open the page** could
  serve a tampered page. Use the companion on networks you trust (home, not a café). A native app with a pinned
  key would remove this limit.
- Counters are saved about once a minute. After a restart, a message captured in the last two minutes could in
  theory be replayed once (the timestamp window still applies).
- Windows asks once whether COre may accept connections on private networks. Allow it for the phone to connect.
- If the QR code shows the wrong address (several network adapters, a VPN), set `phone.host` in `config.json`.

## Tested

- Unit: pairing, refusal, single use, expiry, sealed sync/send/stop, replay, stale timestamp, forged key,
  revocation, private-address checks, static file serving with a strict CSP (`test/companion.test.js`).
- End to end in the app: a Pixel 7 browser profile scanned the invitation URL, paired, sent a message, received the
  reply, and showed "Not paired" right after the phone was removed in Settings.
- Not tested: a real phone on a real Wi-Fi, the Windows firewall prompt.

## Missions from the phone (13.0)

- The sync feed carries the current mission (goal, subgoals, how each was verified) and any request waiting for an
  answer (mission card, escalated step), each with a hash of exactly what it approves and a 5-minute expiry.
- `approve { id, hash, answer, bio }`: the answer applies only to that request (the hash must match). **Yes** needs
  `bio: true`, which the phone app sets only after Android's fingerprint/face/screen-lock prompt succeeds
  (BiometricConfirm, added to the Android build by `mobile/scripts/patch-android.js`). **No** never needs it.
- `missionStop`: ends the mission and any desktop task at once (the same path as the emergency stop).
- Known limit: the PC trusts the phone's `bio` flag; it cannot verify it cryptographically. A key held in the
  Android keystore that only unlocks after biometric confirmation would close this and is planned.
