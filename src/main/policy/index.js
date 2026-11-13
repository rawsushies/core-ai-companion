'use strict';

// The policy engine (13.0): the single gate every agent action passes. It replaces the
// earlier scattered checks (SAFE / allow-all in agent.js, mustAsk in main.js) and is
// fully deterministic: the model proposes, the policy decides.
//
//   decide(action) -> { decision: 'allow' | 'journal' | 'escalate' | 'deny', cls, category, reasons, tainted }
//
//   allow     R0 (viewing)
//   journal   R1 in scope: done without asking, recorded with what undoes it
//   escalate  R2 not named in the grant, any tainted outward target, R3 boundaries the user
//             may still approve (payments, security settings)
//   deny      passwords and codes (the user types those), COre's own safeguards, commands
//             its checks refuse, or a grant that is invalid or expired
//
// Without a grant (manual mode, the 12.x default) every change escalates: that is the
// "approve every step" behaviour, now expressed as policy.

const { classify } = require('./classify');
const { verifyGrant } = require('./grant');
const { Taint } = require('./taint');

// COre never types passwords or codes for a mission (the user does), and never touches its own safeguards.
const ALWAYS_DENY = new Set(['safeguards', 'credential']);
const OUTWARD = new Set(['send', 'network', 'outside-scope', 'install', 'commands-unsandboxed']);

class Policy {
  // grant: signed grant or null (manual); key: grant key; taint: Taint; audit(entry)
  constructor({ grant = null, key = null, taint = null, audit = () => {}, safeguardPaths = [], sandbox = true, allowCommands = [], folders = [], killFile = '', now = () => Date.now() } = {}) {
    this.killFile = killFile; // a file whose presence halts every action (an out-of-process emergency stop)
    this.folders = folders.map((f) => require('path').resolve(f)); // manual mode: the shared folders (relative paths start in the first)
    this.allowCommands = allowCommands; // manual mode: commands the user allowlisted never ask (12.x behaviour)
    this.grant = grant;
    this.key = key;
    this.taint = taint || new Taint({ trusted: grant ? [grant.goal, ...grant.folders, ...grant.hosts, ...grant.apps] : [] });
    this.audit = audit;
    this.safeguardPaths = safeguardPaths;
    this.sandbox = sandbox;
    this.now = now;
    this.heartbeat = now();
    this.counts = { delete: 0, write: 0 };
  }

  // Dead-man: executors call alive() before acting; a policy that stopped beating
  // (crashed, replaced, stopped) refuses everything.
  beat() { this.heartbeat = this.now(); }

  // The user approved a grant mid-task (e.g. "Allow all for this task"). Only a valid,
  // signed grant is accepted; nothing else can change what the policy allows.
  upgrade(grant) {
    const v = verifyGrant(grant, this.key, { now: this.now() });
    if (!v.ok) throw new Error(v.reason);
    this.grant = grant;
    this.taint.trust([grant.goal, ...grant.folders, ...grant.hosts, ...grant.apps].join('\n'));
  }
  alive(maxMs = 30000) { return !this.stopped && !this.killed() && this.now() - this.heartbeat < maxMs; }
  killed() { try { return !!this.killFile && require('fs').existsSync(this.killFile); } catch { return true; } }
  stop() { this.stopped = true; }

  decide(action, ctx = {}) {
    const g = this.grant;
    const record = (r) => { try { this.audit({ at: this.now(), grant: g ? g.id : null, action: action.type, ...r }); } catch {} return r; };
    if (this.stopped || this.killed()) return record({ decision: 'deny', cls: 3, category: 'safeguards', reasons: ['all actions are stopped'], tainted: [] });
    if (g) {
      const v = verifyGrant(g, this.key, { now: this.now() });
      if (!v.ok) return record({ decision: 'deny', cls: 3, category: 'safeguards', reasons: [v.reason], tainted: [] });
    }
    const c = classify(action, { ...ctx, grant: g || { folders: ctx.folders || this.folders, apps: [], hosts: [], categories: [] }, safeguardPaths: this.safeguardPaths, sandbox: this.sandbox });
    // Targets that leave the machine or the scope must not come from untrusted content.
    // (Paths inside the granted folders are bounded by the grant and backed up, so a file
    // name read from a listing may be used there.)
    const outward = OUTWARD.has(c.category) || action.type === 'fetch' || action.type === 'run' || (['type', 'fill'].includes(action.type) && c.targets.length > 0);
    const tainted = outward ? this.taint.check(c.targets) : [];
    const base = { cls: c.cls, category: c.category, reasons: [...c.reasons], tainted };
    if (ALWAYS_DENY.has(c.category)) return record({ decision: 'deny', ...base });
    if (c.cls === 0) return record({ decision: 'allow', ...base });
    if (!g) {
      // In manual mode a routine step may be turned into a grant for the rest of the task
      // ("Allow all for this task"): offerGrant tells the UI it may offer that.
      if (c.cls === 1 && action.type !== 'run') base.offerGrant = true;
      if (action.type === 'run' && c.cls === 1 && !tainted.length) {
        const AT = require('../agentTools');
        const cc = AT.checkCommand(action.cmd);
        if (cc.ok && AT.allowed(cc.argv, this.allowCommands)) return record({ decision: 'journal', ...base, reasons: [...base.reasons, 'on your list of commands that never ask'] });
      }
      return record({ decision: 'escalate', ...base, reasons: [...base.reasons, 'manual mode: every change asks'] });
    }
    if (tainted.length) return record({ decision: 'escalate', ...base, reasons: [...base.reasons, `${tainted.map((t) => t.target).join(', ')} came from ${[...new Set(tainted.flatMap((t) => t.from))].join(', ')}, not from you`] });
    if (c.cls === 3) return record({ decision: 'escalate', ...base });
    if (action.type === 'run' && c.cls === 1 && g.commands === false) {
      const AT = require('../agentTools');
      const cc = AT.checkCommand(action.cmd);
      if (!(cc.ok && AT.allowed(cc.argv, this.allowCommands))) return record({ decision: 'escalate', ...base, reasons: [...base.reasons, 'commands ask one by one in this task'] });
    }
    if (c.cls === 2) {
      if (c.category === 'delete') this.counts.delete++;
      if (c.category === 'delete' && this.counts.delete > 20 && !g.categories.includes('bulk')) return record({ decision: 'escalate', ...base, reasons: [...base.reasons, 'more than 20 deletions in this mission'] });
      return record({ decision: g.categories.includes(c.category) ? 'journal' : 'escalate', ...base });
    }
    return record({ decision: 'journal', ...base });
  }
}

module.exports = { Policy, Taint, ...require('./grant'), classify };
