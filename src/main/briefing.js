'use strict';

// Morning briefing (13.0 P4): once a day, the first time you are at the PC after the morning
// starts, COre gives a short briefing built only from things it can name a source for:
//   - today's calendar (your ICS feed, via the calendar skill)
//   - Cortex to-dos that are overdue or due today
//   - what missions and desktop tasks did since yesterday (COre's own records)
// Nothing is invented: a section without data is left out, and every line says where it came from.

function isDue(task, today) { return task.overdue || (task.due && task.due <= today); }

// data: { calendar: [string] | null, tasks: [{ text, due, overdue }] | null, missions: [{ goal, status, at }],
//         now: Date } -> { text, spoken, empty }
function build({ calendar = null, tasks = null, missions = [], now = new Date() } = {}) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const day = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const lines = [`Good morning. Here is ${day}.`];
  const said = [];
  if (calendar && calendar.length) {
    lines.push(`**Calendar** (your calendar feed): ${calendar.slice(0, 6).join('; ')}`);
    said.push(`${calendar.length} thing${calendar.length > 1 ? 's' : ''} on your calendar`);
  } else if (calendar) lines.push('**Calendar** (your calendar feed): nothing today.');
  const due = (tasks || []).filter((t) => isDue(t, today));
  if (due.length) {
    lines.push(`**Due** (Cortex to-dos): ${due.slice(0, 6).map((t) => `${t.text}${t.overdue ? ' (overdue)' : ''}`).join('; ')}${due.length > 6 ? ` and ${due.length - 6} more` : ''}`);
    said.push(`${due.length} to-do${due.length > 1 ? 's' : ''} due`);
  }
  const recent = (missions || []).filter((m) => m && now - m.at < 24 * 3600e3);
  if (recent.length) {
    lines.push(`**Since yesterday** (COre's mission records): ${recent.slice(0, 4).map((m) => `${m.goal.slice(0, 80)}: ${m.status === 'done' ? 'done' : m.status === 'ask' ? 'needs you' : m.status}`).join('; ')}`);
    const waiting = recent.filter((m) => m.status === 'ask').length;
    if (waiting) said.push(`${waiting} mission${waiting > 1 ? 's' : ''} waiting for you`);
  }
  const empty = lines.length === 1 || (lines.length === 2 && calendar && !calendar.length && !due.length && !recent.length);
  const spoken = said.length ? `Good morning. Today you have ${said.join(', ')}. The details are in the chat.` : 'Good morning. Nothing urgent today.';
  return { text: lines.join('\n'), spoken, empty };
}

// The briefing is due once per day: after `fromHour` (default 6), on the first tick that finds you
// at the PC (idle under a minute), never twice the same day.
function due({ now = new Date(), lastDay = '', idleSec = 0, fromHour = 6 } = {}) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; // local day
  return now.getHours() >= fromHour && day !== lastDay && idleSec < 60 ? day : null;
}

module.exports = { build, due };
