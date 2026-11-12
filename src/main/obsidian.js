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

module.exports = { vaultPath, isObsidianVault, noteUri };
