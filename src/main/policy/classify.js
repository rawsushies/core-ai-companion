'use strict';

// Deterministic risk classification of one validated agent action (13.0 policy engine).
// No model is involved. Risk classes:
//   R0 view                  looking, reading, waiting, scrolling
//   R1 reversible in scope   UI input in granted apps, file changes in granted folders
//                            (journaled with a backup), sandboxed commands, granted hosts
//   R2 high impact           sending, deleting, installing, network outside the grant,
//                            unsandboxed commands, anything outside the scope; allowed only
//                            when the grant names the category, otherwise the user is asked
//   R3 mandatory boundary    passwords and codes, payments, security settings, COre's own
//                            safeguards; always asked or refused, never grantable
//
// -> { cls: 0..3, category, targets: [strings whose origin matters], reasons: [] }

const path = require('path');
const AT = require('../agentTools');

const VIEW = new Set(['wait', 'scroll', 'move', 'done', 'ask', 'read', 'focus', 'expand']);
const CRED_RE = /\b(pass(word|code|phrase)?|pin|otp|one[- ]time|2fa|mfa|verification code|security code|cvv|cvc|secret|api[ _-]?key|token)\b/i;
const PAY_RE = /\b(pay( now)?|purchase|buy( now)?|checkout|place order|confirm (order|payment|purchase)|transfer|subscribe|renew|donate)\b/i;
const SEND_RE = /\b(send|reply|forward|post|publish|share|submit|tweet|upload)\b/i;
const DELETE_RE = /\b(delete|remove|erase|empty (the )?(trash|recycle bin)|wipe|purge|discard)\b/i;
const SECSET_RE = /\b(firewall|defender|antivirus|uac|user account control|bitlocker|two[- ]factor|2fa|mfa|security|privacy|permissions?|password manager|auto-?lock|accounts?)\b/i;
const INSTALL_RE = /\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bnpx\b|\bpip3?\s+install\b|\bwinget\b|\bchoco(latey)?\b|\bscoop\b|\bapt(-get)?\s+install\b|\bmsiexec\b|\bsetup\.exe\b|\binstaller\b/i;
const SECRET_TEXT_RE = /\b(sk-[a-z0-9-]{8,}|ghp_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|api[_-]?key\s*[=:]\s*\S{8,})/i;
const SETTINGS_APPS = /^(settings|ms-settings|control( panel)?|regedit|gpedit|secpol|windows security|defender|firewall|services|task scheduler|credential manager)$/i;

const lower = (s) => String(s || '').toLowerCase();

function inside(p, folders) {
  const r = path.resolve(p);
  return folders.some((f) => r === f || r.startsWith(f.endsWith(path.sep) ? f : f + path.sep));
}

// ctx: { grant, cwd (folder relative paths start in), safeguardPaths: [abs], window: { app, title }, ui: { elements } }
function classify(a, ctx = {}) {
  const g = ctx.grant || { folders: [], apps: [], hosts: [], categories: [] };
  const reasons = [];
  const out = (cls, category, targets = []) => ({ cls, category, targets, reasons });
  const abs = (p) => path.resolve(ctx.cwd || (g.folders[0] || process.cwd()), String(p || ''));
  const guarded = (p) => (ctx.safeguardPaths || []).some((s) => { const r = path.resolve(p); return r === s || r.startsWith(s + path.sep); });
  const appOk = () => !ctx.window || !ctx.window.app || !g.apps.length || g.apps.includes(lower(ctx.window.app));

  if (VIEW.has(a.type)) {
    if (a.type === 'read' && guarded(abs(a.path))) { reasons.push('COre\'s own settings and keys are not readable by missions'); return out(3, 'safeguards'); }
    if (a.type === 'read' && !inside(abs(a.path), g.folders)) { reasons.push('reading outside the granted folders'); return out(2, 'outside-scope', [abs(a.path)]); }
    return out(0, 'view');
  }

  switch (a.type) {
    case 'write': case 'rename': case 'delete': {
      const paths = a.type === 'rename' ? [abs(a.from), abs(a.to)] : [abs(a.path)];
      if (paths.some(guarded)) { reasons.push('changes COre\'s own settings or safeguards'); return out(3, 'safeguards'); }
      if (paths.some((p) => AT.SECRET_RE.test(p))) { reasons.push('touches a credentials file'); return out(3, 'credential'); }
      if (!paths.every((p) => inside(p, g.folders))) { reasons.push('outside the granted folders'); return out(2, 'outside-scope', paths); }
      if (a.type === 'delete') { reasons.push('deleting (a backup is kept)'); return out(2, 'delete', paths); }
      if (/(^|[\\/])outbox([\\/]|$)/i.test(paths[paths.length - 1])) { reasons.push('placing a file in an outbox sends it'); return out(2, 'send', paths); }
      if (a.type === 'write' && SECRET_TEXT_RE.test(a.text || '')) { reasons.push('the text contains what looks like a secret'); return out(3, 'credential'); }
      if (a.type === 'write' && /(^|[\\/])(settings|config|preferences)[^\\/]*\.(json|ini|ya?ml|toml)$/i.test(paths[0]) && SECSET_RE.test(a.text || '')) { reasons.push('changes security-related settings'); return out(3, 'security-settings'); }
      return out(1, 'reversible', paths);
    }
    case 'run': {
      const c = AT.checkCommand(a.cmd);
      if (!c.ok) { reasons.push(`command refused: ${c.reason}`); return out(3, 'safeguards'); }
      const targets = [c.argv.join(' '), c.argv[0]];
      if (INSTALL_RE.test(a.cmd)) { reasons.push('installs software'); return out(2, 'install', targets); }
      if (ctx.sandbox === false) { reasons.push('no OS sandbox available'); return out(2, 'commands-unsandboxed', targets); }
      if (a.cwd && !inside(abs(a.cwd), g.folders)) { reasons.push('runs outside the granted folders'); return out(2, 'outside-scope', targets); }
      return out(1, 'reversible', targets);
    }
    case 'fetch': {
      let host = '';
      try { host = new URL(a.url).hostname.toLowerCase(); } catch { reasons.push('bad url'); return out(3, 'safeguards'); }
      const granted = g.hosts.includes('*') || g.hosts.some((h) => host === h || host.endsWith(`.${h}`));
      if (!granted) { reasons.push(`${host} is not a granted website`); return out(2, 'network', [host, a.url]); }
      return out(1, 'reversible', [host, a.url]);
    }
    case 'open': {
      if (SETTINGS_APPS.test(a.app)) { reasons.push('opens system or security settings'); return out(3, 'security-settings'); }
      if (g.apps.length && !g.apps.includes(lower(a.app))) { reasons.push(`${a.app} is not a granted app`); return out(2, 'outside-scope', [a.app]); }
      return out(1, 'reversible', [a.app]);
    }
    case 'key': {
      if (/^(win|super|cmd|meta)\+r$/.test(a.combo)) { reasons.push('opens the Run dialog'); return out(2, 'outside-scope'); }
      if (!appOk()) { reasons.push('typing into an app outside the grant'); return out(2, 'outside-scope'); }
      if (/(^|\+)(enter|return)$/.test(a.combo) && ctx.focused && (PAY_RE.test(ctx.focused) || SEND_RE.test(ctx.focused))) { reasons.push(`confirms "${ctx.focused}"`); return out(PAY_RE.test(ctx.focused) ? 3 : 2, PAY_RE.test(ctx.focused) ? 'payment' : 'send'); }
      return out(1, 'reversible');
    }
    case 'type': case 'fill': {
      const field = `${a.label || ''} ${ctx.focused || ''}`;
      const el = a.el && ctx.ui ? (ctx.ui.elements || []).find((e) => e.id === a.el) : null;
      if ((el && el.password) || CRED_RE.test(field)) { reasons.push('entering a password or code'); return out(3, 'credential'); }
      if (SECRET_TEXT_RE.test(a.text || '')) { reasons.push('the text contains what looks like a secret'); return out(3, 'credential'); }
      if (!appOk()) { reasons.push('typing into an app outside the grant'); return out(2, 'outside-scope'); }
      return out(1, 'reversible', /@/.test(a.text || '') ? [a.text] : []);
    }
    case 'press': case 'click': {
      const name = String(a.label || ctx.target || '');
      if (PAY_RE.test(name)) { reasons.push(`presses "${name}"`); return out(3, 'payment'); }
      if (SECSET_RE.test(name) && /\b(off|disable|allow|turn off|grant|always)\b/i.test(name)) { reasons.push(`changes a security control ("${name}")`); return out(3, 'security-settings'); }
      if (!appOk()) { reasons.push('clicking in an app outside the grant'); return out(2, 'outside-scope'); }
      if (SEND_RE.test(name)) { reasons.push(`presses "${name}"`); return out(2, 'send'); }
      if (DELETE_RE.test(name)) { reasons.push(`presses "${name}"`); return out(2, 'delete'); }
      return out(1, 'reversible');
    }
    default:
      reasons.push(`unknown action ${a.type}`);
      return out(3, 'safeguards');
  }
}

module.exports = { classify, inside, CRED_RE, PAY_RE, SEND_RE, SECRET_TEXT_RE };
