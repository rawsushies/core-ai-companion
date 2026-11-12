'use strict';

// Mission grants (13.0 policy engine). A grant is what the user approved for one mission:
// the scope (folders, apps, hosts), the high-impact categories it may do without asking,
// budgets and an expiry. Grants are frozen and signed with a local key so nothing (least
// of all model output) can widen one; a wider scope needs a new grant and a new approval.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// High-impact categories a grant may name (risk class R2). R3 boundaries are never grantable.
const GRANTABLE = ['send', 'delete', 'install', 'network', 'commands-unsandboxed', 'bulk'];
const NEVER = ['credential', 'payment', 'security-settings', 'safeguards'];

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// A per-install secret, created once, readable only by this user.
function loadKey(dir) {
  const f = path.join(dir, 'policy.key');
  try { const k = fs.readFileSync(f); if (k.length === 32) return k; } catch {}
  const k = crypto.randomBytes(32);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, k, { mode: 0o600 });
  return k;
}

const sign = (body, key) => crypto.createHmac('sha256', key).update(canonical(body)).digest('hex');
const uniq = (a) => [...new Set((a || []).map((x) => String(x).trim()).filter(Boolean))];

// -> frozen, signed grant. Throws on anything not grantable.
function createGrant(o, key, { now = Date.now() } = {}) {
  const categories = uniq(o.categories);
  const bad = categories.filter((c) => !GRANTABLE.includes(c));
  if (bad.length) throw new Error(`${bad.join(', ')} cannot be granted${bad.some((c) => NEVER.includes(c)) ? '; COre always asks for that' : ''}.`);
  const body = {
    v: 1,
    id: o.id || `g-${crypto.randomBytes(6).toString('hex')}`,
    goal: String(o.goal || '').slice(0, 500),
    folders: uniq(o.folders).map((f) => path.resolve(f)),
    apps: uniq(o.apps).map((a) => a.toLowerCase()),
    hosts: uniq(o.hosts).map((h) => h.toLowerCase()),
    categories,
    commands: o.commands !== false, // sandboxed commands in scope run without asking (false = each command asks, as in 12.x)
    budget: { steps: Math.max(1, Math.min(500, Number(o.budget && o.budget.steps) || 60)), minutes: Math.max(1, Math.min(24 * 60, Number(o.budget && o.budget.minutes) || 30)) },
    issuedAt: now,
    expiresAt: Number(o.expiresAt) || now + 24 * 3600e3,
    approvedBy: String(o.approvedBy || 'user'),
  };
  return Object.freeze({ ...body, budget: Object.freeze(body.budget), folders: Object.freeze(body.folders), apps: Object.freeze(body.apps), hosts: Object.freeze(body.hosts), categories: Object.freeze(body.categories), sig: sign(body, key) });
}

// -> { ok, reason }
function verifyGrant(g, key, { now = Date.now() } = {}) {
  if (!g || typeof g !== 'object' || !g.sig) return { ok: false, reason: 'no grant' };
  const { sig, ...body } = g;
  const want = sign(body, key);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { ok: false, reason: 'the grant was changed after it was approved' };
  if (now > g.expiresAt) return { ok: false, reason: 'the grant has expired' };
  return { ok: true };
}

// Human-readable lines for the approval card.
function describeGrant(g) {
  const lines = [`Goal: ${g.goal}`];
  lines.push(g.folders.length ? `Folders: ${g.folders.join(', ')}` : 'Folders: none');
  if (g.apps.length) lines.push(`Apps: ${g.apps.join(', ')}`);
  if (g.hosts.length) lines.push(`Websites: ${g.hosts.join(', ')}`);
  lines.push(g.categories.length ? `Also allowed without asking: ${g.categories.join(', ')}` : 'High-impact actions (sending, deleting, installing) will ask first.');
  lines.push(`Budget: ${g.budget.steps} steps, ${g.budget.minutes} min; expires ${new Date(g.expiresAt).toISOString().slice(0, 16).replace('T', ' ')}`);
  lines.push('Always asks: passwords, payments, security settings. Never: turning off COre\'s safeguards.');
  return lines;
}

module.exports = { GRANTABLE, NEVER, createGrant, verifyGrant, describeGrant, loadKey, canonical };
