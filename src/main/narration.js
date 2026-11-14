'use strict';

// Mission narration (13.0 P4): milestones only, never every step. Turns mission engine events into
// at most a few short lines; the interruption model then decides whether each is spoken, shown
// silently or sent to the phone.
//   narrate(event, live) -> null | { kind, importance, line }
// Milestones: halfway (missions of 3+ subgoals), complete, needs you, stopped / budget used up.
// A first failed attempt is not narrated (COre retries on its own).

function narrate(e, live) {
  if (!e || !live) return null;
  const subs = live.subgoals || [];
  const n = subs.length;
  if (e.type === 'verify' && e.ok && n >= 3) {
    const done = subs.filter((s) => s.status === 'done').length;
    if (done === Math.ceil(n / 2) && done < n && !live.saidHalfway) {
      live.saidHalfway = true;
      return { kind: 'mission-progress', importance: 'low', line: `Halfway through the mission: ${done} of ${n} steps verified.` };
    }
    return null;
  }
  if (e.type === 'end') {
    const verified = subs.filter((s) => s.status === 'done').length;
    if (e.status === 'done') return { kind: 'mission-end', importance: 'normal', line: n ? `Mission complete: all ${n} step${n > 1 ? 's' : ''} verified.` : 'Mission complete.' };
    if (e.status === 'ask') return { kind: 'mission-end', importance: 'urgent', line: 'The mission needs you.' };
    return { kind: 'mission-end', importance: 'high', line: `The mission stopped${e.reason ? `: ${String(e.reason).slice(0, 100)}` : ''}. ${verified} of ${n} steps were verified.` };
  }
  return null;
}

module.exports = { narrate };
