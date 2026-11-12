# Knowledge layer: COre × Obsidian × Cortex × Syncthing

```
COre (agent, reasoning, active memory, desktop execution)
        ↕  src/main/memgate.js — the only memory interface (read, write, recall,
        ↕  provenance, queue while offline, sync-conflict awareness)
Obsidian-compatible Markdown vault  ← the one source of truth (plain files)
        ↕  Cortex indexes it (SQLite index + caches kept LOCAL, outside the vault)
Cortex (long-term memory, retrieval, links, version history) over MCP

PC vault ↔ Syncthing ↔ other devices' vaults   (transport only; free, peer to peer)
```

| Part | Role | Where |
|---|---|---|
| COre | Creates, retrieves and reasons about knowledge, only through the gateway | `src/main/memgate.js` |
| Vault | Plain Markdown folder. Notes are what Obsidian shows and edits | user's folder (setting `memory.cortex.vault`) |
| Obsidian | Human interface to the same files. Optional: nothing depends on it running | `/obsidian [note]` opens the vault or a cited note |
| Cortex | Indexes the vault incrementally (re-checks changed files by mtime/size at most every 2 s), recall, health, history (last 30 versions per note) | bundled `Cortex.exe` (installer) or a checkout |
| Syncthing | Moves the files between devices. Not a memory engine | user-installed; COre only reads its local status |

## How changes flow

- **COre → vault → Cortex:** a decision COre remembers is written by Cortex (atomic temp-file + rename) into
  `Projects/<project>.md`, indexed immediately.
- **Obsidian → vault → Cortex → COre:** an edit saved in Obsidian changes the file; Cortex's next re-check
  re-indexes it, so COre's next recall has it. No import step.
- **Other device → Syncthing → vault → Cortex → COre:** a note that arrives from another device is just a changed
  file, indexed the same way.
- **Offline:** COre and Cortex work on the local vault. Notes COre writes while Cortex is down wait in COre's queue;
  Syncthing delivers file changes when devices reconnect.
- **Conflicts:** when two devices edit the same note while apart, Syncthing keeps both versions
  (`Note.sync-conflict-…md`). Nothing is overwritten: COre's recall says two versions exist and won't choose,
  `/vault` and `/suggest` list them, Cortex's health check reports them, and the user merges them in Obsidian.
- **New device / fresh install:** point COre at the synced vault folder; Cortex builds a new local index from the
  files. The index is never synced (a database copied mid-write would be corrupted).

## Automatic setup

On the first start of a new install COre turns on its built-in Cortex, creates the vault (`Documents\COre Vault`,
unless Cortex already uses one) with a welcome note, and adds it to Obsidian's vault list (`obsidian.json`) so it
appears in Obsidian with no folder picking. No account, API key or plugin is involved. If Obsidian is not installed,
`/vault obsidian` installs it (official winget package) and connects it; if you install it yourself later, COre
adds the vault on its next start. Existing users: `/vault setup`. Turn it off in Settings → Privacy.

## Setting up a second device (free, no Obsidian Sync)

1. Install Syncthing on both devices (syncthing.net) and pair them (Add Remote Device, by device ID).
2. On the PC, share the vault folder; accept it on the other device into an empty folder.
3. On the other device: COre Settings → Privacy → Knowledge vault folder = that folder (or open it in Obsidian).
4. `/vault` shows the vault, Cortex, Syncthing state, connected devices and any conflicts.

Do not sync the Cortex index folder (`%LOCALAPPDATA%\Cortex`), and do not put the vault inside a Drive/OneDrive
folder *and* Syncthing at once.

## Evidence

`test/vault.sync.test.js` (runs in CI on Linux): two real Syncthing devices over loopback, two real Cortex MCP
servers each with its own local index, real files. It proves: COre memory appears as a Markdown note; an
Obsidian-style edit and a note created outside COre are indexed and recalled; device B receives the knowledge and
its Cortex finds it; a change on B returns to A; changes made while B was offline synchronize after reconnection
while COre keeps working; conflicting edits keep both versions and are reported; a fresh install with an empty
index reconnects to the vault and recalls. In that test, Obsidian edits are file writes, which is how Obsidian saves.

The real Obsidian is covered separately on Windows CI: `test/obsidian.win.test.js` installs Obsidian, lets COre
create the vault and add it to Obsidian's vault list, launches Obsidian and checks (through UI Automation) that it
opened the COre vault on the note COre wrote (Obsidian 1.15.0: window "Tower - COre Vault - Obsidian").
`test-e2e/installed.e2e.js` drives two installed copies of COre: first launch, bundled Cortex, vault, Obsidian
list, remember and recall, and the knowledge travelling both ways over real Syncthing (verified on a Linux package
build; the Windows installer run is the `installed-windows` CI job). Typing inside Obsidian is not automated.
