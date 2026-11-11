# Changelog

## Unreleased

### COre 2.0, part 9: Smart model routing

- Conversation stays on the fast Claude model (Haiku by default) and its warm session is never restarted; the **desktop agent, the specialist cores and playbook writing run on the stronger model** (Sonnet by default). Settings, Brain: "Smart routing" and "Stronger Claude model"; choose "Use the model above for everything" to turn it off.
- Changing brain settings now also refreshes the agent's and idle specialists' brains.

### COre 2.0, part 8: Ash and the board

- **The board**: when an explanation deserves it, COre crumbles into ash, streams its smoke out into a board about **a third of the screen wide** beside itself, writes a title and up to four points in smoke while the crisp text condenses in (blur to sharp, points one by one), holds it while talking them through, then pulls the smoke back and reforms with a shockwave. The brain triggers it with `[[board TITLE; POINT; POINT]]`; demo key **B**.
- **Ash dispersion**: grey ash with glowing embers that drift out and down through the smoke flow; used for the board transition and available to other effects.
- After the words appear, the smoke settles into the board's frame so it never doubles the text. Reduced-motion skips the ash and the shockwave.
- Fixed: the smoke jumped when COre's window grew or moved (for example when pointing); particles now stay put on the desktop.

### COre 2.0, part 7: Command center

- **One window for everything COre is doing** (tray → Command center, the button in quick settings, or `/center`): the desktop agent's task with Stop / Resume / Undo, the six cores and which are working, recent shared tasks, playbooks with their next scheduled run and a Run button, memory health (counts, recently replaced facts, Tidy up now), phone / Google Drive / backup status, recent files, and a filterable activity log with warnings highlighted.
- A large **Emergency stop** button in the header (same as Ctrl+Alt+Shift+X).
- Fixed: agent steps were written to the activity log one character per field.

### COre 2.0, part 6: Playbooks and workflows

- **Playbooks**: reusable how-tos as `SKILL.md` files (the Agent Skills format) in COre's data folder, `skills/<name>/SKILL.md`. COre knows each one by name and description, follows a playbook when a request fits it (trigger phrases or matching words), and can hand it to a specific core (`core: sentinel`).
- **`/skills`** lists them, **`/skill NAME input`** runs one, **`/skill save NAME`** has COre write a new playbook from the current conversation (it never overwrites an existing one).
- **Workflows**: a playbook with `schedule:` (`daily 08:30`, `weekdays 17:00`, `mon,wed 09:15`, `every 2h`) runs on its own; runs are logged and remembered across restarts.
- Four examples on first run: meeting-notes (Archivist), code-review (Sentinel), site-report for IFC/DXF (Archivist), and daily-briefing (scheduled, off until you enable it).
- Fixed: a brain request without an item handler could crash the speech planner.

### COre 2.0, part 5: Collaborating specialists

- Two new cores: **Archivist** (memory and files: answers from what COre remembers, past work and the file shelf, cites its sources, and points out stale or conflicting memories) and **Navigator** (desktop and browser operator: plans the clicks and shortcuts, and leaves a ready `/do …` in the message box for you to start).
- **Sentinel reviews Forge**: every file change Forge proposes gets an automatic review with a verdict (Settings, Projects; on by default). In a shared task with both, Sentinel reviews Forge's result instead of working blind in parallel.
- Prime routes `[[delegate]]` work to the new roles by topic.

### COre 2.0, part 4: File intelligence

- **Drop files on the chat** (or use the paperclip) and they become Drive-style cards above the message box. Selected cards go with your messages; **Sum** summarizes one.
- Read locally, no upload step: **PDF** (Mozilla pdf.js, scripts never run; a built-in reader as fallback), **Word/ODT**, **Excel/CSV/TSV** (every sheet as rows), **PowerPoint**, **images** (sent to a vision model, large ones shrunk), **code and text**, **IFC** (BIM: schema, project, storeys, element counts, spaces, materials) and **DXF** (CAD: version, extents, layers, entity counts, drawing text). DWG asks for a DXF export.
- **Audio and video** are decoded in the app and transcribed by the local Whisper model (up to 15 minutes); videos also contribute four frames.
- All file content reaches the brain fenced as untrusted data; files with instruction-like text are flagged.
- Cards persist across restarts (up to 40, stored in the app's data folder).

### COre 2.0, part 3: Autonomous agent tools

- The desktop agent can now also **run commands, read/write/move/delete files and read web pages** (Settings, Agent; on by default once the agent is enabled).
  - Commands: no shell (argv only), pipes/redirects/variables refused, destructive programs and git push/reset blocked, working folder jailed to the project, secrets removed from the environment, timeout and capped output. **Every command asks**, even after "Allow all steps", unless it matches `agent.allowCommands` (e.g. `git status`).
  - Files: only inside the project folder (symlinks resolved), secret files (`.env`, keys, credentials) refused, atomic writes, and a backup before every change. **`/do undo`** puts back every file the last task touched.
  - Web: https only, no local network addresses, text pages only, size-capped.
  - Every result goes back to the brain fenced as untrusted data (prompt-injection guard), and suspicious text is flagged.
- **Verification**: a task that changed something gets one more look (a fresh screenshot) before it counts as done.
- **Recovery**: after a failed step the brain is told to try another way; four failures in a row end the task.
- **Persistent tasks**: progress is checkpointed every step. **`/do resume`** continues a stopped, limited or crashed task; COre mentions an interrupted task at startup.

### COre 2.0, part 2: Security core
- **Emergency stop:** Ctrl+Alt+Shift+X (changeable) or the tray's "Emergency stop" halts everything at once:
  - the desktop agent
  - every running reply
  - helpers' work and speech
  - song reading
  - the phone link
  - pending approvals

  It's logged, and COre shows what it stopped.
- **Prompt-injection guard:** file contents reach the brain fenced as data, with COre's own action syntax broken, so
  a document can't trigger an action. Instruction-like text ("ignore previous instructions", "send your API key",
  "run this command…") is flagged in the chat and in the audit log.

### COre 2.0, part 1: Memory Intelligence Engine
- Every memory now has a kind (profile, preference, project, history, fact), a confidence score, its sources and
  its history.
- **Automatic capture:** clear statements in your messages ("my name is…", "I live in…", "I prefer…",
  "remember that…", some Bahasa Indonesia) are saved and shown in the chat. Questions and "what if" sentences are
  ignored. Off switch: Settings → Privacy.
- **Confidence:** saying something again makes COre surer. Unused facts slowly lose certainty unless pinned, and
  unsure facts are marked as such to the brain.
- **Contradictions:** a new fact replaces an opposite one ("likes X" → "hates X") or another value for the same slot
  (where you live, your name…). The old one is kept in its history.
- **Project history:** finished shared tasks and desktop-agent tasks are remembered as episodes, tagged with the
  current project, and recalled when relevant.
- **Smarter search:** keywords plus fuzzy matching, plus meaning-based search with a small local model (downloads
  about 23 MB once; falls back gracefully when offline).
- **Consolidation:** a daily pass merges near-duplicates and retires stale, unused history.
- **Pin** (★) keeps a fact always in use. The memory list shows confidence and separates facts from history.

### Fixed
- The chat stopped following new messages when several arrived quickly (a shared task): it now stays pinned to
  the newest message unless you scroll up yourself.
- Desktop agent on Linux: a click could fail under some window managers (`xdotool --sync`); it now retries without
  waiting.

### Launch kit
- Five banners, a 30-second promo video with original synthesised music, and a 90-second demo recorded from the
  real app: `assets/brand/v11/` (see `docs/BRAND.md`).

### Fewer antivirus false alarms
- The song card and the desktop agent run their PowerShell helpers as plain script files that ship with the app
  (`src/main/ps/`), instead of encoded commands with the execution-policy bypass. Antivirus heuristics flag that
  pattern, and AVG quarantined COre.
- README: how to restore COre if an antivirus removes it.

## 11.0.0 — Agent, phone app, cards and a new chat

### Memory in your Google account (optional)
- Settings → **Cloud**: connect your Google account and COre keeps its memory in your Drive's private app folder.
  It asks for the `drive.appdata` permission only and can't see anything else.
- Memory is merged both ways after every change and hourly. Deletions stay deleted.
- Sign-in is Google's desktop flow (PKCE, local callback). Only the refresh token is kept, encrypted.
- You need your own free OAuth client: steps in `docs/dev/CLOUD.md`.

### COre for Android (new app)
- `mobile/` is a real Android app (Capacitor). CI builds an installable debug APK.
- **With your PC** on the same Wi-Fi, it's paired like the phone page (encrypted) and gets chat, status, the media
  remote and Stop.
- **Away from the PC** it answers with Gemini using your own key, and still knows you: it keeps a copy of COre's
  memory from the PC.
- **For low and mid-range phones:** a light 2D orb picked by device class (180–520 particles at 24–30 fps). It
  stops when hidden.
- The desktop now answers the app's origin only (CORS) and serves a sealed memory copy. See `docs/dev/MOBILE.md`.

### Fixed (found by the new agent test)
- **Closing any card beside the orb stopped the phone companion server** (a misplaced line from the phone
  milestone). Phones lost their connection after "hide that" or any card timing out. Fixed, with a regression test.

### Desktop agent (off by default)
- `/do TASK` lets COre operate the PC: it looks at the screen, then clicks, types, presses keys, scrolls or opens
  apps one step at a time.
- Every step that changes something waits for **Allow** (or **Allow all steps**), and COre points where it will click.
- **Esc**, **Stop** or any message ends it.
- Fixed action set with validation and blocked key combos; drivers take parameters as data (xdotool on Linux, a
  fixed SendInput helper on Windows).
- Details: `docs/dev/AGENT.md`.

### Live task card
- When several cores work on one request (for example `@Scout @Sentinel compare…`), a card beside the orb shows
  each specialist with a live status: working…, done, failed. It never covers a song or lyrics card, and it goes
  away a few seconds after the last one finishes.

### Voice starts sooner on long openings
- When a reply opens with a long sentence without a comma, the first few words are now spoken on their own as soon
  as 48 characters have arrived (was 70). Measured with the voice model: each spoken chunk costs about 0.7 s plus
  about 11 ms per character, so this starts the voice about 0.25–0.45 s sooner on those replies.

### Album art on the song card
- The now-playing and lyrics card shows the album cover: from the Windows media session's thumbnail (read once per
  track), or from the player's art link on Linux (local file, or https fetched only while the card is open, at most
  600 KB, images only).
- The Linux media reading is now tested end to end with a stand-in player.

### Phone media remote
- The phone companion has previous / play-pause / next / volume buttons that press the PC's media keys (fixed keys
  only, like the music skill; respects the music switch).
- Screen readers no longer announce every lyric line of the lyrics card.

### Live cards beside the orb
- Setting a timer shows a live countdown card for a few seconds; "how long left?" brings it back instantly
  (no brain). When a timer ends, a "Time's up" card shows next to the reminder.
- Asking for the weather shows a card with now, today and tomorrow while COre talks about it.
- Asking about your calendar shows a card with the day's events.

### Fixed (loop 1 audit)
- Backups no longer contain paired phones' keys (on Linux without a keyring they were unencrypted), and restoring a
  backup keeps the phones paired with this PC.
- A phone whose clock is more than 2 minutes off no longer retries endlessly: COre tells it the right time, and it
  retries once.
- Scrolling over a gap between chat messages scrolls the chat (Windows and macOS), instead of the app underneath.

### Tests
- New end-to-end suite against the real app (`npm run e2e`, also in CI on Linux): chat reply, instant answers, the
  glance card, paused rendering, plain-text notes, every Settings section, backup to a cloud folder without secrets,
  phone pairing / chat / removal, and no renderer errors.

### Instant answers sound instant
- Short spoken lines are kept after the first time, and the quick-answer lines ("Paused.", "Next one."…) are
  rendered in the background a little after start, only while COre is quiet. They're rendered again when you change
  the voice or pitch. Measured with the real voice model: about 300 ms to synthesise a short phrase, 0 ms from the
  cache.

### Safety
- Messages from the phone never trigger a screenshot, even with "look at this": a screenshot needs someone at the PC.

### Zero cost when you're not looking
- Hidden (Ctrl+Alt+H), screen locked or PC asleep: COre and its helpers draw no frames at all. Measured in safe
  graphics mode: **53% → 1.7%** CPU. Before, the hidden window kept rendering in the background.
- Nobody at the PC for 5 minutes: the idle smoke slows to 4 fps until you're back.
- On battery: idle is capped at 10 fps and animations at 30 fps.
- While idle only half the smoke particles are simulated and drawn (a random half, same brightness; 35% when you're
  away), easing back to all of them the moment COre does anything. Measured in safe graphics: idle 51.6% → 45.5%
  CPU. Larger profiles have more particles, so they should save more (not measured on a real GPU). Setting:
  `orb.idleDetail`.

### Phone companion (off by default)
- Chat with COre from your phone's browser on the same Wi-Fi: see the chat and COre's status, send messages, stop it
  talking. Settings → Phone → **Pair a phone** shows a QR code; scan it, compare the 6-digit code on both screens,
  click Allow.
- End-to-end encrypted with a per-phone key, with replay protection, and private networks only. Nothing goes through
  the internet. Remove a phone any time and it's locked out at once. Details and honest limits:
  `docs/dev/PHONE.md`.

### Backups (local or cloud folder)
- Settings → Backup keeps copies of your settings, memories, notes, reminders, chat state and plugins in any
  folder. **Use my cloud folder** finds OneDrive, Google Drive, Dropbox or iCloud Drive and uses a `COre Backups`
  folder inside it, so your cloud app syncs the backups. COre itself never talks to a cloud service.
- Automatic backups every day or week (default: daily, once a folder is chosen); the newest 3–30 are kept.
- An optional passphrase encrypts each backup (AES-256-GCM, key from scrypt). The passphrase is stored encrypted
  on this PC and never goes into a backup.
- Never in a backup: API keys, the calendar link, the notification token.
- **Restore…** checks the backup (format, checksum, passphrase), saves your current data first as a
  `pre-restore` snapshot, keeps this PC's keys, and restarts.
- Settings messages no longer stack on top of each other.

### Glance: a card beside the orb
- "What's playing?" shows the current song, artist and progress next to COre. "Show me the lyrics" shows the
  synced lyrics, with the line being sung in Emerald. "Hide that" closes it. COre can also show any short list or
  numbers on its own ("show me today's plan").
- The song comes from the system media session: Windows media controls (Spotify, browsers, most players) or
  playerctl on Linux. It's read only while a music or lyrics card is open, and the card closes by itself after a
  minute of pause.
- Lyrics come from lrclib.net (free, no account). Only the song title and artist are sent, and only when you ask
  for lyrics. There's an off switch (`skills.lyrics`).

### Instant answers
- Short requests are answered on the spot without the brain: the time, the date, play / pause / next / previous /
  louder / quieter / mute, show or hide the lyrics or now-playing card. Measured in the app: about 40–200 ms
  instead of a model round trip, and no usage. Anything longer still goes to the brain. Switch: `skills.quick`.
- Notes in the chat lost their emoji (Noted, Music, Opening, Timer set).

### Chat redesign (brand kit)
- The chat under the orb is one clear panel: no fill (your screen shows through), a solid brand-coloured
  frame and dividers. A header shows COre's real mark, its status (Online / Thinking… / Speaking / Offline),
  and history, settings and hide buttons.
- Replies are Smoke bubbles grouped under the speaker's avatar (COre's mark, or the specialist's colour orb).
  Your messages are Void bubbles with an Emerald edge. The input is one filled pill with the recipient orb and
  mic inside it, plus a round Emerald send button.
- Notes like "Remembered…" are plain text with a dark halo, not a bubble. Emoji removed from notes.
- Quick settings are cards in the same style. Back and the title sit in the header, empty reminders are hidden,
  and slider values show in brand mono.
- Gaps in the panel click through to the app below (Windows and macOS).
- Brand audit across windows: the subtitle no longer uppercases names (it showed "CORE"), the old green and
  off-palette greys and whites are replaced with brand colours, the History panel and Settings use the real
  mark and Inter Display, and the History panel matches the chat.

### Lighter on CPU and GPU (measured)
- While idle, COre now sleeps between frames instead of keeping the compositor awake at the display rate.
- New light rendering path: 8-bit buffers, lower resolution and an active-frame cap. It's used by safe
  graphics, the Battery profile and every helper core.
- Measured idle CPU in safe graphics mode (software rendering): **173% → 37%** of one core. On a real GPU these
  savings are GPU time and power instead.
- Profiles retuned: Battery (8,000 particles, 65% resolution, 10 fps idle, 30 fps cap), Balanced (20,000,
  90%, 20 fps idle), Best quality (40,000, full, 45 fps idle). Default idle frame rate 30 → 20.
- Helper cores render at 4,000 particles, 70% resolution and 10 fps idle, light buffers.
- Overlay frame counters (`window.__coreStats()`) and, with `CORE_DEBUG=1`, latency logs (first text, first
  speech). Measured with the real Claude: about 0.7 s to the first word of text and 1.7 s to the first audio on
  warm turns.

### Archicad (read-only proof of concept)
- Turn on Settings → Skills → "Read my open Archicad project" and ask COre how many doors, walls or windows the
  open project has. COre talks to Archicad's built-in JSON API on this PC only (127.0.0.1, ports 19723–19743)
  and can only use read commands; nothing in the model can be changed. Not yet tested against a real
  Archicad. See docs/dev/RESEARCH-PHASE5-6.md for the integration research (Archicad, Revit via pyRevit
  Routes, Windows UI Automation) and the secure Android companion design.

### Approved file changes (you click Apply)
- With Settings → Projects → "Let cores propose changes" on (off by default), a core can propose a whole file:
  it writes the new file in a code block tagged `file=path`. The chat shows a card with the file, +/− counts
  and a red/green diff. **Nothing is written until you click Apply**, and Reject throws it away.
- Apply refuses if the file changed since the proposal (so your edits are never overwritten), backs the
  original up, and writes atomically. Every applied change has **Undo**, which also refuses if you edited the
  file afterwards.
- New files only inside existing folders of the shared project. Same containment and secret rules as
  reading, text only, size-capped. No deleting, renaming or running anything. Every write, rejection and
  undo goes into `logs/tools.log`.

### Cores can read your project (read-only, with permission)
- Share one project folder in Settings → Projects (system folder picker; Stop sharing at any time). COre and
  its cores can then list, read and search it with `[[list]]`, `[[read]]` and `[[find]]`, and answer from
  the actual files ("Forge searched for TODO (1 hit)").
- Read-only by design: no writing, no running anything, no shell. Paths are resolved through symlinks, so
  nothing outside the folder is reachable. Secret-looking files (`.env`, keys, `credentials.json`…) are always
  refused, dependency folders are skipped, and file size and output are capped.
- Every access appears in the chat as it happens and is written to `logs/tools.log`.
- Specialists can take up to three rounds of reading in their own session before answering.

### Meiosis Mode: four cores, one chat
- **Minimal, on-brand chat** (replaces the glass bubbles from earlier in this cycle):
  - A flat Void panel at 88% opacity with a hairline border, narrower at 320 px. When idle it fades to 28% so
    it blends back into your screen.
  - Replies are plain text under a small coloured name ("Scout · Research"). Your messages are a quiet block
    on the right, and system notes are muted text.
  - The core wheel and @ chips are flat coloured dots. The rings and highlights stay subtle.
- COre's brand type (Inter, Inter Display, JetBrains Mono, all OFL) is now bundled with the app and used in the
  chat, Settings, history and subtitles, so it looks the same on every PC. Settings and history use the brand
  palette.
- New chat look: replies are glassy bubbles tinted in each core's colour, each with a small swirling
  smoke-orb avatar. Consecutive replies from the same core share one avatar. Your messages show which
  cores they went to as coloured chips, and progress and errors are small centred pills. The old coloured
  side bars are gone.
- The **core wheel**: the orb next to the input shows who you're talking to. Click it and a ring of the four
  cores spins in, turning the chosen one to the top. Arrow keys turn it, Enter or a click picks. Typing `@`
  shows the cores as orb pills. Animations stop with reduced motion, and names are always written out.
- COre is now four cores total: **COre** (Prime, the coordinator and default recipient) and three
  specialists that split off as smoke helpers. **Scout** researches and compares, **Forge** builds and drafts,
  **Sentinel** reviews and finds problems. They are role profiles over the same brain you already use, not
  extra AI services.
- One chat for all of them. Every reply is labelled with the core's name and role in its colour. Progress,
  errors and actions are marked, and messages you send to a specialist say who they went to.
- Talk to a core by starting with `@Scout`, `@Forge`, `@Sentinel` or `@COre` (autocomplete pops up when you
  type `@`), with the recipient chip next to the input, by clicking a specialist's smoke, or by voice:
  "Scout, …". With no name, the message goes to COre. Unknown names aren't guessed: COre lists the names it knows.
- Address several at once (`@Scout @Sentinel review this`) to start a shared task. They work in parallel,
  then COre sums up the results in one answer.
- Each specialist keeps its own conversation (separate context) while it's on screen, handles messages to
  it one at a time, and merges back after 10 idle minutes (or when poked). Stop also stops specialists.
- COre can hand work to a specialist itself (`[[delegate Scout …]]`). The older `[[clone …]]` and `/clone`
  pick a fitting specialist.
- Floating subtitles show who is speaking, and only one core speaks at a time (COre first).
- Specialists can't open files, run commands or browse yet (that's the coming permissioned task engine); their
  instructions say so, so they won't pretend.
- Names, aliases, colours and voices are configurable in `config.json` → `meiosis.cores`.
- `/stop @Scout` and `/merge @Forge` act on specific cores (`/stop` and `/merge` alone act on all).
- A shared task interrupted by COre closing is marked as interrupted, and COre tells you when it next starts.
  It is never re-run on its own.
- COre's summary of a shared task waits until every specialist has finished speaking, instead of cutting
  them off. Only you talking to COre interrupts a specialist.

### Release engineering
- Releases now come only from an explicit version tag, never from a `package.json` change. They go through
  blocking gates (syntax check, tests, packaged-app self-test, Windows installer install/uninstall test) and
  land as a **draft** for a human to publish. See docs/dev/RELEASING.md.
- New CI on every branch and pull request (Linux + Windows), with blocking tests.
- Fixed the release build: it ran two GitHub publishers that raced, so releases lost files and never
  included `latest.yml`. Builds now upload the installer, blockmap, `latest.yml` and SHA256SUMS together.
- Removed the code-signing publisher check from unsigned builds (it would have made installed copies reject
  every update).
- `--smoke-test=<file>`: COre can self-test (windows load, orb draws, native modules and worker files
  present) and exit with a pass/fail code. Used by CI and the release gates.
- The Claude CLI tests now also run on Windows, through a `.cmd` shim like the real CLI.

### Updates you can trust, and undo
- Source installs now update from **published releases** by default (Settings → Privacy → Update from),
  not from every change on `main`. The downloaded code must carry the release's version, or it's refused.
  Developers can opt into the `main` channel.
- Every source update first backs up the current version and puts it back if applying fails halfway (disk
  full, a locked file). If the updated COre then fails to start twice in a row, it restores the previous
  version automatically and tells you. This works even when the new version can't load at all, thanks to a
  small bootstrap (`boot.js`) that updates never replace.
- After a rollback, packages are reinstalled only if the failed update had changed them.

### Your data is never overwritten
- A damaged `config.json`, `state.json`, `memory.json` or `notes.json` (a hand-edit typo, a disk problem) is
  now kept as `<file>.corrupt-<time>`, and COre tells you where. Before, it was silently replaced, losing
  settings, API keys, memories or notes.
- Memory keeps a `.bak` of the previous good file and skips invalid entries. Notes are written atomically.

### Fixes
- Messages arriving from a window while it closes (during restart or quit) no longer throw errors in the
  main process.

### Calendar you can rely on
- Recurring events now show (daily, weekly on chosen days, monthly like "2nd Tuesday" or "last Friday",
  yearly), with `COUNT`/`UNTIL`/`INTERVAL`, cancelled occurrences (`EXDATE`) and moved occurrences.
  Before, a weekly meeting only appeared on the day of its very first occurrence.
- Event times are read in their own time zone (with daylight-saving), including Outlook's Windows zone
  names. Before, a 09:00 meeting in another zone showed at 09:00 local time.
- The private calendar link is stored encrypted like API keys (an existing plain-text link is moved over
  automatically), is never shown again in Settings ("Saved (hidden)" with Remove), and can't leak into the
  chat, the brain or logs through error messages.

### A sturdier brain (same brains, better behaved)
- Watchdogs on every provider: one that doesn't start answering within 90 s, or goes silent for 45 s
  mid-answer, is abandoned (configurable via `brain.timeouts`). If nothing was said yet, the next brain in
  your chain takes over. Before, a stalled provider could hold a turn for four minutes.
- An answer that breaks off midway keeps what was already said, says why, and offers **Continue the
  answer** instead of discarding everything.
- Stopping a reply yourself is no longer counted as a provider failure.
- Per-provider health (successes, failures, last error, typical time to first word) appears in Copy diagnostics.
- Conversation history for Gemini/Groq/OpenRouter/Ollama is bounded by size as well as count, so long pastes
  can't overflow small local models. Ollama keeps the model loaded between turns instead of reloading it.

### Memory that stays consistent
- A new fact about the same thing replaces the old one instead of contradicting it ("lives in Bandung"
  supersedes "lives in Jakarta"; favourites are per thing). The old value is kept in the fact's history and
  COre says "🧠 Updated: … (was: …)". Detection is deliberately conservative: only facts clearly about you.
- Project facts: `[[remember #Tower the client wants a glass facade]]` is kept per project and comes up when
  that project is mentioned.
- Every fact records when and where it came from (voice, chat, or you).
- Edit facts in place in the chat's memory panel (✎), next to Forget. Hover a fact to see its date, source
  and earlier wording.

### Problems are no longer silent
- If something unexpected breaks inside COre, it now says so once in the chat (and tints the orb if it keeps
  happening) instead of only writing to the crash log.

## 10.3.0 — New look, fewer loose ends
- New brand: a logo made of smoke filaments, new app and tray icons, a wordmark where the orb is the "O",
  README banner, social preview, promo images for every major format, and a brand guide (docs/BRAND.md).
- Fixed: hiding COre left its helper clones floating on screen; helpers now hide and reappear with it, and a
  helper made while COre is hidden stays hidden too.
- Fixed: "Hey COre" or the talk hotkey while COre was hidden listened with no visible orb; COre now
  reassembles first.
- Fixed: quitting or restarting (including after an update) while helpers were working left their Claude
  processes running in the background.
- Fixed: unplugging the monitor COre lived on (or dropping the resolution) could leave it off-screen; it now
  comes back to a visible spot.
- Fixed: Reset kept your saved notes. It now forgets them along with memory and history.
- The tray tooltip now tells you when hands-free is listening for "Hey COre".
- Two small lists no longer grow forever in sessions that run for weeks.

## 10.2.0 — A voice with feelings
- Emotion-driven voice: when COre's mood changes, its voice follows. It speaks a little faster and brighter
  when excited or happy, slower and lower when sad, softer when calm. The chat text stays in step.
- Re-checked the original voice bugs with the real Claude and the real neural voice: an 8-sentence reply
  was spoken in full, each sentence started within about 0.1 s of the last, and the text reveal matched
  every sentence's audio length.
- Debug logging (`CORE_DEBUG=1`) now shows brain tags, pointing corrections and voice timing.

## 10.1.0 — Tested with the real Claude
- First full test against real Claude (not a stand-in). Notes, skill lookups, helper clones and screen
  pointing all worked; pointing landed within a few pixels of the target.
- COre is now visibly expressive with Claude: replies come with fitting body language (a wave for good
  morning, a laughing smoke face after a pun, a shrug for "who knows", counting to three for three tips).
  Before, Claude rarely used its gestures.
- More automatic gestures when the brain doesn't pick one: "three tips" counts to three, "hard to say"
  shrugs, jokes and puns get a flourish.
- Skills now use the system network settings (proxy and certificates), so weather and calendar work behind
  corporate proxies.
- Helper results in the chat no longer repeat their spoken summary.
- A real point no longer fights with a "point right" gesture sent at the same time.

## 10.0.0 — Release
- Full audit across every system at once (chat, voice, gestures, shapes, skills, helpers, hands-free,
  settings), in the real app and in the packaged build. No page errors, an empty crash log, and about 1% CPU
  in total while idle.
- New README covering everything COre can do, privacy, settings and development.
- Release notes attached to the GitHub release; optional code signing for the Windows installer (add
  `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` repository secrets).
- Bugs found and fixed on the way to 10.0.0: a cough could pass as a wake phrase; the first watch-mode offer
  could be swallowed; a skill follow-up could cut the previous reply's chat text; a plugin hint could echo back
  as a tag; a finished helper lost its colour; drags with a fast release weren't detected as tosses.

## 9.0.0 — Polish
- Themes: pick COre's smoke colour: Emerald (classic), Ice, Ember, Violet, Gold, Rose or Moonlight. It
  applies instantly.
- Performance profiles: Battery saver, Balanced or Best quality, all with one choice.
- Reply language: COre can always answer in the language you pick (Bahasa Indonesia, English, Japanese…),
  whatever language you type or speak in.
- Accessibility: reduce motion (follows Windows' setting by default: no fidgets, calmer drift, no
  speaking shiver), larger chat text, and captions on or off.
- Local crash reports: problems are written to COre's own logs folder (never uploaded), included in "Copy
  diagnostics", and one click away in Settings → Maintenance.
- First-run tour: on the first launch COre waves, points at the chat, makes a smoke heart and shows you
  around in five short lines (replay it from the tray or Settings).

## 8.0.0 — Skills
- COre can now do things, not just talk: take and look up **notes**, set **timers**, tell you the
  **weather** (free Open-Meteo, no key; set your city in Settings → Skills), **control music**
  (play/pause/next/previous/volume), **open apps** from a safe list (Spotify, VS Code, calculator,
  settings, terminal…), offer a **web search**, and read your **calendar** from a private ICS feed link.
- Lookups come back into the conversation: COre says "one moment", checks, then tells you the answer.
- Plugins: drop a small JSON file in COre's data folder → `skills/` to add search-style skills, e.g.
  `{"name": "wiki", "description": "search Wikipedia", "url": "https://en.wikipedia.org/wiki/Special:Search?search={q}"}`.
- Safe by design: nothing runs a command made from the model's words (apps and media keys are fixed
  lists), new pages open only when you click, plugins are data (https links), not code, and every skill
  can be switched off in Settings → Skills.

## 7.0.0 — Screen partner
- Watch mode: when an error dialog, crash report, failed install or "(Not Responding)" window appears,
  COre glows, mentions it, and offers a **Take a look** button in the chat. It only reads window titles
  to notice this; a screenshot is taken only when you click. Rate limited (one offer a minute, the same
  problem at most every 10 minutes), quiet while you're talking to it, and switchable in Settings → Privacy.
- Smarter pointing: when COre points at something on a screenshot, the smoke finger snaps onto the nearest
  button, icon or label instead of landing next to it.
- Multi-monitor: summon COre with a hotkey on another screen and it reassembles there, so it can point
  at what you're looking at (Settings → Look → Move to the screen I'm using).

## 6.0.0 — Hands-free
- "Hey COre": an optional wake phrase, detected entirely on this PC (Settings → Voice, or tray →
  Hands-free). A cheap sound detector only passes short phrases that follow a pause to the local speech
  model, so ordinary conversation is never transcribed and nothing leaves the computer. Say
  "Hey COre" and talk, or say it all at once: "Hey COre, what time is it?"
- Barge-in: with hands-free on, just start talking while COre speaks; it stops and listens (echo
  cancellation keeps its own voice from triggering this).
- Hold to talk: press and hold the orb, speak, let go to send.
- Talk hotkey mode: "stops when I pause" (as before) or "press again to send" for long thoughts.
- Conversation mode: COre listens again for a few seconds after each spoken reply, so a back-and-forth
  doesn't need the hotkey every time.

## 5.0.0 — Many COres
- Helpers: COre can split off up to 3 helper copies that work on tasks in parallel (research from what it
  knows, drafting, planning, writing code) while you keep talking to COre itself. Ask for several things at
  once, or type `/clone <task>` in the chat.
- Meiosis split: COre pushes apart in a burst of smoke and the helper condenses out of it, then drifts to
  its own spot. Clicking a finished helper (or `/merge`, or tray → Call helpers back) merges it back in.
- No overlap: each helper picks the nearest free spot that covers neither COre, the chat nor another
  helper. Each has its own colour (cyan, amber, violet), its own voice and pitch, and its own separate
  conversation, so their contexts never mix.
- One voice at a time: helpers wait for the floor and only speak (a one-sentence summary) while COre is
  quiet. COre always has priority, and starting to talk to COre stops a helper mid-sentence. Full results
  appear in the chat, marked with the helper's name and colour.
- Light: helpers use a smaller orb, fewer particles and a lower idle frame rate, and their brain process
  stops as soon as the task is done.

## 4.0.0 — Companion presence
- Idle chit-chat: after a quiet while (25 min by default) COre starts a short, relevant conversation on
  its own: the time of day, what you seem to be working on, something it remembers, a fun fact or a game.
  It's polite about it. It only speaks when you're at the computer but paused (never mid-typing, never
  when you're away), never in quiet hours (22:00–08:00 by default), at most 6 times a day, and it waits
  twice as long each time you ignore it.
- Touch it: pet COre (slow strokes) and it hums and glows happily, sometimes with a smoke heart; tickle it
  (quick wiggles) and it giggles into a laughing face; poke it (quick double click) and it jumps, and gets
  annoyed if you keep going; toss it (fling while dragging) and it flies, spins and lands where it went.
  Now and then it says something about it (can be turned off).
- Games: tray → Play a game (trivia, riddle, 20 questions), or just ask. COre hosts and keeps score.
- New settings: chit-chat on/off, quiet time, quiet hours, talk-back reactions.

## 3.0.0 — Shape-shifting
- COre's smoke can form shapes: emoji faces (laugh, smile, sad, wink, surprised, cool, angry), heart,
  check, cross, question/exclamation marks, star, sun, moon, music note, light bulb, Zzz, arrows,
  infinity, clock, lightning, ring, and any one to three letters or digits ("42", "OK").
- Shapes come with matching voice sounds through the robot voice: a giggle with the laughing face, a hum,
  a sigh, a gasp, a ding, a buzz or a thoughtful "hmm". The next sentence waits for the sound.
- `[[form NAME]]` tag for the brain; a "haha" in a reply makes COre laugh in smoke on its own.
- Cheap by design: each shape is drawn once into 2,048 target points and uploaded as one tiny texture;
  the smoke simply flows to them.

## 2.0.0 — Body language
- 30 gestures, all made from COre's own smoke arms and body, so they cost nothing extra on the GPU:
  wave, thumbs up/down, shrug, count to five, clap, facepalm, point up/down/left/right, beckon, stop,
  OK, peace, rock, heart hands, think, salute, fist pump, celebrate, juggle, hug, magic, flex, bow,
  nod, shake, spin and bounce.
- Smoke hands now have individually moving fingers (each finger curls and straightens).
- COre picks gestures while it talks (`[[gesture NAME]]`), and when it doesn't, adds one that fits
  what it's saying now and then: a wave for hello, a shrug for "no idea", a count for "second…".
- Idle fidgets: every so often COre juggles, flexes, ponders or waves on its own.

## 1.0.0 — Real app
- Settings window (tray → Settings…, or ⚙ → All settings… in the chat): every option in one place,
  grouped into General, Look, Voice, Brain and Privacy. Changes apply instantly where possible; the
  few that need a restart say so and offer a Restart button. Values are checked before they're saved,
  and shortcut clashes are refused.
- Start COre when you sign in (optional).
- Maintenance: check for updates, copy diagnostics, open the data folder, restart, reset (forget settings,
  memory and history; downloaded models stay) and uninstall.
- Windows installer: `COre-Setup-<version>.exe`, built automatically on GitHub for every release, with
  Start-menu and desktop shortcuts, a choice of folder, and a proper uninstaller in Windows' Apps list.
  Installed copies update themselves from GitHub Releases; source copies keep updating from `main`.

## 0.5.0 — Harmony & glass
- Fixed flicker while dragging and while idle: COre's window is now a fixed-size square that only moves
  (moving doesn't redraw; resizing did). It resizes once when a drag or far point starts and once after.
  Measured: 0 resizes during 15 s of idle life, 2 for a whole drag.
- Fixed a drag that could get stuck (no drop) when the window resized under the pointer.
- The chat hides while you drag COre and reappears under it when you drop.
- Fixed replies going quiet after a few sentences: typed replies are now spoken in full (code is skipped).
- Voice ⇄ text harmony: each spoken sentence's words appear over the real length of its audio, typed or
  spoken questions alike.
- Chat redesign: 340 px translucent glass, shows just the latest exchange (⌃ expands history), fades almost
  away after 7 s idle and returns on hover, typing or when COre talks.

## 0.4.1 — Alive and quick
- New orb animations: assembles from scattered smoke on start and when shown, dissolves when hidden,
  shockwaves on click / drop / notifications / reminders, an inhale when it starts listening, a faster spin
  while thinking, and small idle behaviours (a spin, a hop, a ripple) every 25-45 s.
- Much faster voice: 4-bit voice model (~3x quicker to render), tiny first spoken phrase, speech recognition
  warmed up in the background (the first spoken question no longer waits for it to load).
  Measured on a slow 4-core cloud machine: typed question to first spoken word 4.1 s -> 1.7 s; spoken question
  (from end of speech) 7.3 s -> 3.6 s.
- Instant feedback: typing dots in the chat and a "got it" pulse the moment you stop talking.
- Fixes: offered action buttons no longer accumulate forever; the window makes room for the scattered smoke
  while COre assembles or dissolves.

## 0.4.0 — COre gets a memory and a life
- Long-term memory across conversations (works with every brain), managed in ⚙ → Memory.
- Reminders and timers that survive restarts, with voice, glow and a Windows notification.
- One-click actions: open a website or copy text, only when you click.
- Clipboard awareness ("explain what I copied").
- Moods: the smoke changes colour and motion with the feel of the reply.
- Presence: the orb notices your cursor; a built-in greeting on the first launch of the day.
- Fixes: Electron 45's clipboard API is asynchronous (clipboard content now reaches the brain); a finished
  spoken answer interrupted mid-speech stays complete in the chat; unclosed `[[` text is no longer dropped;
  the history panel no longer grows without limit.

## 0.3.1
- Screenshots go to Claude inline; open-window list; voice and chat text in sync; settings Back button;
  drag fixes; staggered start-up.

## 0.3.0
- Persistent Claude session (replies start in about a second); crash-free restarts; voice latency work.
