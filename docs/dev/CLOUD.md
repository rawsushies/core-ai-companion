# COre's memory in your Google account (optional)

COre can keep its memory (the facts it remembers about you) in **your Google Drive's private app folder**. That's
a hidden folder only COre can read. COre asks for the `drive.appdata` permission only, so it can't see anything
else in your Drive. The desktop syncs after each change and every hour; the phone app gets the same memory from
the PC.

## One-time setup (about 5 minutes)

Google requires every app to have its own OAuth client. COre doesn't ship one, so you create your own (free):

1. Open https://console.cloud.google.com/ and create a project (any name).
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **APIs & Services → OAuth consent screen:** choose *External*, fill in the app name and your email, and add
   yourself as a **test user**. While it's in testing, only your own account can sign in.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app.**
5. In COre: Settings → **Cloud**. Paste the **client ID** and **client secret** (stored encrypted), then click
   **Connect Google**. Your browser opens Google's sign-in, and COre receives a one-time code on `127.0.0.1`.

## What syncs

- **Synced:** facts are merged both ways: new ones are added on each side, and a fact you delete stays deleted
  everywhere (deletions are remembered for 90 days).
- **Not synced:** settings, chats and keys are never sent. Use Settings → Backup with a Drive-synced folder for those.
- **Disconnecting:** **Disconnect** revokes COre's token. The file in the app folder stays until you remove COre
  under your Google account → Security → Third-party connections.

## Gemini

Gemini is separate from Drive: it uses an API key (aistudio.google.com/apikey). On the desktop it's in Settings →
Brain (a fallback brain). On the phone it's in the app's Settings, as the brain for away mode.

## Tested

Unit tests run against a fake Google. They cover the full sign-in (PKCE S256 verified, state checked, local
callback), token refresh, creating then updating the file in `appDataFolder` (never duplicated), and the merge
rules. Not tested here: a real Google account (needs your OAuth client).
