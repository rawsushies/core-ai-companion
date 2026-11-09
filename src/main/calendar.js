'use strict';

// Minimal, dependency-free iCalendar (ICS) reader for COre's calendar skill.
// Handles what real Google / Outlook / iCloud feeds use most:
//   - DTSTART in UTC (Z), floating local time, all-day (VALUE=DATE), and
//     TZID=<IANA zone> (via Intl). Windows zone names (Outlook) fall back to
//     the feed's own VTIMEZONE standard offset.
//   - RRULE: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL,
//     BYDAY (weekly days, or monthly "2TU" / "-1FR"), BYMONTHDAY.
//   - EXDATE (cancelled occurrences) and RECURRENCE-ID (moved occurrences).
// Expansion is bounded (only the asked range, capped iterations).

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_STEPS = 5000;

// Offset (ms) of `zone` at instant `t` (UTC ms), via Intl. null if unknown zone.
function zoneOffset(t, zone) {
  let f;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return null;
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
}

// Wall-clock fields in `zone` -> UTC instant.
function zonedToUtc(y, mo, d, h, mi, s, zone, fallbackOffsetMs) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  const o1 = zoneOffset(guess, zone);
  if (o1 === null) return fallbackOffsetMs != null ? guess - fallbackOffsetMs : new Date(y, mo, d, h, mi, s).getTime();
  const o2 = zoneOffset(guess - o1, zone); // settle DST edges
  return guess - o2;
}

function parseOffset(v) { // "+0700" / "-0500"
  const m = /^([+-])(\d{2})(\d{2})/.exec(String(v || ''));
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : null;
}

// value + params -> { t (UTC ms), allDay }
function parseDate(value, params = {}, zones = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h || params.VALUE === 'DATE') return { t: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)), allDay: false };
  if (params.TZID) {
    const tz = params.TZID.replace(/^"|"$/g, '');
    return { t: zonedToUtc(+y, +mo - 1, +d, +h, +mi, +(s || 0), tz, zones[tz]), allDay: false };
  }
  return { t: new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)).getTime(), allDay: false }; // floating = local
}

function parseLine(line) {
  const i = line.indexOf(':');
  if (i < 0) return null;
  const [name, ...ps] = line.slice(0, i).split(';');
  const params = {};
  for (const p of ps) { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1); }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

const unescape = (v) => String(v).replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

function parseIcs(text) {
  const lines = String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  // Pass 1: VTIMEZONE standard offsets (for zone names Intl doesn't know, e.g. Outlook's Windows names).
  const zones = {};
  let tz = null; let inStd = false;
  for (const l of lines) {
    if (l === 'BEGIN:VTIMEZONE') tz = {};
    else if (l === 'END:VTIMEZONE') { if (tz && tz.id && tz.off != null) zones[tz.id] = tz.off; tz = null; } else if (tz) {
      if (l === 'BEGIN:STANDARD') inStd = true;
      else if (l === 'END:STANDARD') inStd = false;
      const p = parseLine(l);
      if (!p) continue;
      if (p.name === 'TZID') tz.id = p.value;
      if (inStd && p.name === 'TZOFFSETTO') tz.off = parseOffset(p.value);
    }
  }
  // Pass 2: events.
  const events = [];
  let ev = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue; }
    if (l === 'END:VEVENT') { if (ev && ev.start != null) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const p = parseLine(l);
    if (!p) continue;
    if (p.name === 'SUMMARY') ev.title = unescape(p.value);
    else if (p.name === 'LOCATION') ev.location = unescape(p.value);
    else if (p.name === 'UID') ev.uid = p.value;
    else if (p.name === 'STATUS') ev.status = p.value.toUpperCase();
    else if (p.name === 'RRULE') ev.rrule = p.value;
    else if (p.name === 'DTSTART') { const d = parseDate(p.value, p.params, zones); if (d) { ev.start = d.t; ev.allDay = d.allDay; } } else if (p.name === 'EXDATE') {
      for (const v of p.value.split(',')) { const d = parseDate(v, p.params, zones); if (d) ev.exdates.push(d.t); }
    } else if (p.name === 'RECURRENCE-ID') { const d = parseDate(p.value, p.params, zones); if (d) ev.recurrenceId = d.t; }
  }
  return events;
}

function parseRule(s) {
  const r = {};
  for (const part of String(s).split(';')) { const [k, v] = part.split('='); if (k && v) r[k.toUpperCase()] = v; }
  return r;
}

// Occurrence starts of a recurring event within [from, to).
function expand(ev, from, to) {
  const r = parseRule(ev.rrule);
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? (parseDate(r.UNTIL) || {}).t : Infinity;
  const start = new Date(ev.start);
  const out = [];
  let n = 0;
  const emit = (t) => {
    if (t < ev.start || t > until || n >= count) return false;
    n++;
    if (t >= from && t < to && !ev.exdates.includes(t)) out.push(t);
    return true;
  };
  // Keep wall-clock time across DST by stepping in local calendar fields.
  const at = (y, mo, d) => new Date(y, mo, d, start.getHours(), start.getMinutes(), start.getSeconds()).getTime();
  const byday = r.BYDAY ? r.BYDAY.split(',') : null;
  for (let step = 0; step < MAX_STEPS && n < count; step++) {
    if (freq === 'DAILY') {
      const t = at(start.getFullYear(), start.getMonth(), start.getDate() + step * interval);
      if (t >= to || t > until) break;
      emit(t);
    } else if (freq === 'WEEKLY') {
      const weekStart = at(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay() + step * 7 * interval);
      if (weekStart >= to || weekStart > until) break;
      const days = byday ? byday.map((x) => WD.indexOf(x.slice(-2))).filter((x) => x >= 0).sort() : [start.getDay()];
      const ws = new Date(weekStart);
      for (const wd of days) emit(at(ws.getFullYear(), ws.getMonth(), ws.getDate() + wd));
    } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
      const months = freq === 'MONTHLY' ? step * interval : step * 12 * interval;
      const y = start.getFullYear(); const mo = start.getMonth() + months;
      const first = new Date(y, mo, 1);
      if (first.getTime() >= to || first.getTime() > until) break;
      const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      let days;
      if (byday && freq === 'MONTHLY') {
        days = [];
        for (const b of byday) { // "2TU", "-1FR", "MO"
          const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(b);
          if (!m) continue;
          const wd = WD.indexOf(m[2]);
          const all = [];
          for (let d = 1; d <= dim; d++) if (new Date(first.getFullYear(), first.getMonth(), d).getDay() === wd) all.push(d);
          if (!m[1]) days.push(...all);
          else { const k = Number(m[1]); const d = k > 0 ? all[k - 1] : all[all.length + k]; if (d) days.push(d); }
        }
      } else if (r.BYMONTHDAY) {
        days = r.BYMONTHDAY.split(',').map(Number).map((d) => (d < 0 ? dim + d + 1 : d));
      } else days = [start.getDate()];
      for (const d of days.filter((x) => x >= 1 && x <= dim).sort((a, b) => a - b)) emit(at(first.getFullYear(), first.getMonth(), d));
    } else break; // unsupported FREQ (HOURLY etc.): the first occurrence still shows below
  }
  return out;
}

// Occurrences (as plain events with `start`) overlapping [from, to).
function occurrences(events, from, to) {
  const out = [];
  const moved = new Map(); // uid -> Set(original start) for RECURRENCE-ID overrides
  for (const e of events) if (e.recurrenceId != null && e.uid) { if (!moved.has(e.uid)) moved.set(e.uid, new Set()); moved.get(e.uid).add(e.recurrenceId); }
  for (const e of events) {
    if (e.status === 'CANCELLED') continue;
    if (e.rrule && e.recurrenceId == null) {
      const skip = (e.uid && moved.get(e.uid)) || new Set();
      for (const t of expand(e, from, to)) if (!skip.has(t)) out.push({ ...e, start: t });
    } else if (e.start >= from && e.start < to) out.push(e);
  }
  return out.sort((a, b) => a.start - b.start);
}

function rangeFor(range, now = new Date()) {
  const days = range === 'tomorrow' ? [1, 2] : range === 'week' ? [0, 7] : [0, 1];
  const at = (k) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + k).getTime();
  return [at(days[0]), at(days[1])];
}

function describe(list, range) {
  if (!list.length) return `Nothing on the calendar ${range === 'week' ? 'this week' : range}.`;
  return list.slice(0, 12).map((e) => {
    const d = new Date(e.start);
    const when = e.allDay ? 'all day' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = range === 'week' ? `${d.toLocaleDateString([], { weekday: 'short' })} ` : '';
    return `${day}${when}: ${e.title || 'untitled'}${e.location ? ` (${e.location})` : ''}`;
  }).join('; ');
}

module.exports = { parseIcs, occurrences, expand, rangeFor, describe, zonedToUtc, parseDate };
