# COre

A desktop companion that lives on your screen as a **glossy black liquid orb**.
It talks, listens, looks at your screen when you ask, reaches out a **liquid hand to point** at things,
vibrates while it speaks, moves like liquid, and **changes colour** when something needs your attention.

Its brain is **Claude through your own Claude Code login** — no API key. If Claude is unavailable it
falls back to a **free local model** (Ollama) or any OpenAI-compatible endpoint (DeepSeek, OpenRouter, LM Studio).

| State | Look |
|---|---|
| Idle | black obsidian, faint violet rim, slowly drifting and breathing |
| Listening | cyan rim, ripples with your voice |
| Thinking | violet swirl |
| Speaking | surface vibrates with the words, cool inner light |
| Explaining / pointing | one or two liquid arms grow out of the body |
| Notification | coloured pulsing halo — blue info, green success, amber warning, red urgent |

## Install

You need **Node.js 20+** and, for the Claude brain, **Claude Code** logged in once.

```bash
npm install -g @anthropic-ai/claude-code
```

```bash
claude
```

Inside Claude Code type `/login`, finish the login, then exit. (The native Claude Code installer works too.)

Then, in this folder:

```bash
npm install
```

```bash
npm start
```

`npm install` also downloads the Electron runtime. The first time you talk, COre downloads a small
speech-recognition model (Whisper base, ~80 MB) that then runs locally.

## Use

| Hotkey | Does |
|---|---|
| `Ctrl+Alt+Space` | Talk. Press again to stop early. Pressing while COre talks interrupts it. |
| `Ctrl+Alt+S` | Talk about your screen (COre gets a screenshot and can point at things) |
| `Ctrl+Alt+C` | Open the chat panel to type |
| `Ctrl+Alt+H` | Hide / show the orb |

- **Drag** the orb anywhere; it remembers the spot. **Click** it to open the chat panel.
- **Hover** or click acknowledges a notification colour.
- Phrases like "look at this", "what's on my screen", "where is the…" also share a screenshot automatically
  (turn off with `screen.autoShareOnDeixis`).
- Tray icon: talk, new conversation, settings, quit.

## Settings

Panel menu → **Open settings file** edits `config.json`, then **Reload settings**. Highlights:

```jsonc
{
  "brain": {
    "provider": "claude-cli",          // or "ollama" / "openai-compat"
    "fallback": "ollama",              // used if the primary fails before speaking; "" to disable
    "claude": { "model": "haiku" },    // "sonnet" / "opus" are smarter but slower
    "ollama": { "model": "qwen2.5:7b", "visionModel": "" },   // e.g. "qwen2.5vl:7b" to let it see screenshots
    "openaiCompat": { "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "apiKey": "" }
  },
  "voice": { "voiceName": "", "lang": "", "rate": 1.05, "pitch": 0.85, "sttLanguage": "" },
  "orb": { "radius": 46, "renderScale": 1 }
}
```

- **Free local brain:** install [Ollama](https://ollama.com), run `ollama pull qwen2.5:7b`, and it is used automatically as the fallback (or set it as `provider`).
- **Voice:** COre speaks with your operating system's voices. On Windows, extra/natural voices come from Settings → Time & language → Speech. Set `voice.voiceName` to part of a voice name (e.g. `"Aria"`, `"Indonesia"`). If no voice exists it shows captions silently.
- **Language:** COre replies in the language you speak. Set `voice.sttLanguage` (e.g. `"indonesian"`) if auto-detect mishears you; `voice.sttModel: "onnx-community/whisper-small"` is more accurate but slower.
- **Slow GPU:** lower `orb.renderScale` to `0.7`.

## Notifications from anything

COre listens on `127.0.0.1:47321` for attention requests. Copy the token from the panel menu
(**Copy notification token**), then from any script:

```bash
curl -X POST http://127.0.0.1:47321/notify -H "Authorization: Bearer YOUR_TOKEN" -H "content-type: application/json" -d '{"title":"Build finished","level":"success"}'
```

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:47321/notify -Headers @{Authorization="Bearer YOUR_TOKEN"} -ContentType "application/json" -Body '{"title":"Backup failed","level":"urgent","speak":true}'
```

`level` is `info`, `success`, `warn` or `urgent`; `"speak": true` reads the title aloud.
COre cannot read other apps' system notifications by itself (operating systems don't allow that), so
hook the tools you care about into this endpoint.

## Privacy and safety

- The microphone is opened only while COre is listening, and closed right after. Speech recognition runs locally.
- Screenshots are taken only on `Ctrl+Alt+S`, the panel's "Show my screen" box, or a "look at this" phrase.
  They are saved in COre's own workspace folder (last 5 kept) and sent to the brain you configured.
- The Claude brain runs `claude -p` with **only the read-only `Read` tool** enabled, inside COre's workspace,
  with `--restricted` when your Claude Code supports it. COre never uses `--dangerously-skip-permissions`
  and cannot run commands on your PC.
- The notification endpoint listens on localhost only and requires the per-install token.

## How it works

```
 hotkey / panel ──► main process (Electron)
                     ├─ Whisper STT (worker thread, local)
                     ├─ Brain: Claude Code CLI  ─┐ fallback: Ollama / OpenAI-compatible
                     │   stream ► tag parser ► sentence chunker ► [say | gesture | end]
                     ├─ screen capture ─► ./shots/*.png (Claude reads it)
                     └─ notify server 127.0.0.1:47321
                                │ IPC
 overlay window (transparent, always on top, click-through except over the orb)
   ├─ motion.js   springs: body, lagging tail (liquid), two arms
   ├─ orb-gl.js   WebGL2 raymarched SDF: displaced sphere + smooth-union tail + tapered round-cone arms
   ├─ voice.js    OS text-to-speech queue ► amplitude envelope ► vibration
   └─ listen.js   mic + energy VAD ► 16 kHz PCM
```

The model controls the body with silent tags: `[[point X,Y]]` (screenshot pixels) and `[[explain]]`.

The orb shader uses signed-distance-field techniques from Inigo Quilez's articles
(smooth minimum, exact round cone).

## Develop

```bash
npm test
```

```bash
npm run check
```

Open `src/renderer/overlay/index.html` in Chrome to play with the orb without Electron
(keys: P point at cursor, E explain, T talk, L listen, K think, N notification colours, drag it).
Append `?pose=point` / `explain` / `speaking` / `attention&level=urgent` / `move` for fixed poses.
