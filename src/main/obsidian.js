'use strict';

// Obsidian: the Cortex vault is plain Markdown that Obsidian opens directly
// (Cortex writes atomically and re-indexes edits made in Obsidian). COre only
// builds obsidian:// links to open the vault or a note it cited; it never
// writes Obsidian settings or moves notes.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The vault folder: COre's setting, else CORTEX_VAULT, else Cortex's own config.
function vaultPath(cfgVault, env = process.env, home = os.homedir()) {
  if (cfgVault) return path.resolve(cfgVault);
  if (env.CORTEX_VAULT) return path.resolve(env.CORTEX_VAULT);
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, '.config', 'cortex', 'config.json'), 'utf8')).vault;
    return v ? path.resolve(v.replace(/^~(?=$|[\\/])/, home)) : '';
  } catch { return ''; }
}

const isObsidianVault = (vault) => !!vault && fs.existsSync(path.join(vault, '.obsidian'));

// A note reference from Cortex ("Projects/Lakeside.md") -> an obsidian:// link.
// Uses the absolute path form, which works whatever the vault is named in Obsidian.
// Refs that leave the vault (.., absolute) are refused.
function noteUri(vault, ref = '') {
  if (!vault) return '';
  const rel = String(ref).replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel && (rel.split('/').includes('..') || /^[a-z]:/i.test(rel))) return '';
  const full = rel ? path.join(vault, rel) : vault;
  return `obsidian://open?path=${encodeURIComponent(full)}`;
}

// ── Automatic setup ──────────────────────────────────────────────────────
// Obsidian keeps its list of vaults in obsidian.json (per user). Adding the COre
// vault there makes it appear in Obsidian's vault switcher with no folder picking.
// No account, key or plugin is involved; COre never changes Obsidian's settings
// beyond adding this one entry, and never removes or rewrites other vaults.
function obsidianConfigPath(env = process.env, home = os.homedir(), platform = process.platform) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obsidian', 'obsidian.json');
}

function obsidianInstalled(env = process.env, home = os.homedir(), platform = process.platform) {
  const cands = platform === 'win32'
    ? [path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Obsidian', 'Obsidian.exe'), path.join(env.ProgramFiles || 'C:\\Program Files', 'Obsidian', 'Obsidian.exe')]
    : platform === 'darwin' ? ['/Applications/Obsidian.app'] : ['/usr/bin/obsidian', '/opt/Obsidian/obsidian', '/var/lib/flatpak/app/md.obsidian.Obsidian', path.join(home, 'Applications', 'Obsidian.AppImage')];
  return cands.some((p) => fs.existsSync(p)) || fs.existsSync(path.dirname(obsidianConfigPath(env, home, platform)));
}

// Creates the vault folder (never touching existing notes) with Obsidian's marker
// folder and a short welcome note, so it opens as a vault anywhere.
function ensureVault(vault) {
  if (!vault) return { created: false };
  const created = !fs.existsSync(vault);
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  const welcome = path.join(vault, 'Welcome to COre.md');
  if (created) fs.writeFileSync(welcome, [
    '# Welcome to your COre vault', '',
    'This folder is your long-term knowledge: plain Markdown notes that COre, Cortex and Obsidian all share.', '',
    '- COre saves decisions, lessons and research here (under Projects/ and the logbook).',
    '- Edit or reorganise anything in Obsidian; COre picks up your changes automatically.',
    '- To use it on another device, share this folder with Syncthing (free). See COre\'s docs/VAULT.md.',
    '- Delete this note whenever you like.', '',
  ].join('\n'));
  return { created };
}

// Adds the vault to Obsidian's vault list. Returns 'added' | 'already' | 'no-obsidian' | 'error: …'.
function registerVault(vault, { file = obsidianConfigPath(), now = Date.now(), id = require('crypto').randomBytes(8).toString('hex'), platform = process.platform } = {}) {
  if (!vault) return 'error: no vault';
  if (!fs.existsSync(path.dirname(file))) return 'no-obsidian';
  try {
    let cfg = {};
    if (fs.existsSync(file)) {
      try { cfg = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); } catch { return 'error: Obsidian\'s vault list could not be read, left untouched'; }
    }
    cfg.vaults = cfg.vaults && typeof cfg.vaults === 'object' ? cfg.vaults : {};
    const norm = (p) => { const r = path.resolve(String(p)).replace(/[\\/]+$/, ''); return platform === 'win32' ? r.toLowerCase() : r; };
    if (Object.values(cfg.vaults).some((v) => v && norm(v.path) === norm(vault))) return 'already';
    cfg.vaults[id] = { path: path.resolve(vault), ts: now };
    const tmp = `${file}.core-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg));
    fs.renameSync(tmp, file);
    return 'added';
  } catch (err) { return `error: ${err.message}`; }
}

// Windows: Obsidian's official package through winget (only when the user asks).
const OBSIDIAN_WINGET = ['install', '--id', 'Obsidian.Obsidian', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'];

module.exports = { vaultPath, isObsidianVault, noteUri, obsidianConfigPath, obsidianInstalled, ensureVault, registerVault, OBSIDIAN_WINGET };
