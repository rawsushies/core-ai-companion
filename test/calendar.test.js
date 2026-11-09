'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CAL = require('../src/main/calendar');
const SK = require('../src/main/skills');

const ics = (...events) => ['BEGIN:VCALENDAR', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const day = (y, m, d) => [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
const titles = (list) => list.map((e) => e.title);

test('UTC, floating, all-day and folded/escaped fields', () => {
  const e = CAL.parseIcs(ics(
    ev('SUMMARY:Long title that', ' continues', 'DTSTART;VALUE=DATE:20261110', 'LOCATION:Office\\, 3F'),
    ev('SUMMARY:Standup', 'DTSTART:20261109T093000'),
    ev('SUMMARY:Call', 'DTSTART:20261109T020000Z'),
  ));
  assert.strictEqual(e[0].title, 'Long title thatcontinues');
  assert.strictEqual(e[0].location, 'Office, 3F');
  assert.ok(e[0].allDay);
  assert.strictEqual(e[1].start, new Date(2026, 10, 9, 9, 30).getTime(), 'floating = local');
  assert.strictEqual(e[2].start, Date.UTC(2026, 10, 9, 2, 0));
});

test('TZID times are converted from their own zone (IANA, with DST)', () => {
  const [jkt] = CAL.parseIcs(ics(ev('SUMMARY:J', 'DTSTART;TZID=Asia/Jakarta:20261110T090000')));
  assert.strictEqual(jkt.start, Date.UTC(2026, 10, 10, 2, 0), '09:00 WIB = 02:00 UTC');
  const [ny] = CAL.parseIcs(ics(ev('SUMMARY:N', 'DTSTART;TZID=America/New_York:20260701T090000')));
  assert.strictEqual(ny.start, Date.UTC(2026, 6, 1, 13, 0), 'summer: EDT is UTC-4');
  const [nyw] = CAL.parseIcs(ics(ev('SUMMARY:N', 'DTSTART;TZID=America/New_York:20261201T090000')));
  assert.strictEqual(nyw.start, Date.UTC(2026, 11, 1, 14, 0), 'winter: EST is UTC-5');
});

test('Outlook Windows zone names fall back to the feed VTIMEZONE offset', () => {
  const [e] = CAL.parseIcs(ics(
    ['BEGIN:VTIMEZONE', 'TZID:SE Asia Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0700', 'TZOFFSETTO:+0700', 'END:STANDARD', 'END:VTIMEZONE'],
    ev('SUMMARY:Outlook', 'DTSTART;TZID=SE Asia Standard Time:20261110T090000'),
  ));
  assert.strictEqual(e.start, Date.UTC(2026, 10, 10, 2, 0));
});

test('weekly recurring meeting shows on the right days, with EXDATE cancellations', () => {
  const feed = CAL.parseIcs(ics(ev('UID:w1', 'SUMMARY:Sync', 'DTSTART:20261102T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE:20261111T100000')));
  assert.deepStrictEqual(titles(CAL.occurrences(feed, ...day(2026, 11, 9))), ['Sync'], 'Monday');
  assert.deepStrictEqual(titles(CAL.occurrences(feed, ...day(2026, 11, 10))), [], 'Tuesday');
  assert.deepStrictEqual(titles(CAL.occurrences(feed, ...day(2026, 11, 11))), [], 'Wednesday cancelled by EXDATE');
  assert.deepStrictEqual(titles(CAL.occurrences(feed, ...day(2026, 11, 18))), ['Sync']);
  const [o] = CAL.occurrences(feed, ...day(2026, 11, 16));
  assert.strictEqual(o.start, new Date(2026, 10, 16, 10, 0).getTime(), 'keeps its time of day');
});

test('COUNT, UNTIL, INTERVAL, daily and monthly rules', () => {
  const daily = CAL.parseIcs(ics(ev('SUMMARY:Pills', 'DTSTART:20261101T080000', 'RRULE:FREQ=DAILY;COUNT=3')));
  assert.strictEqual(CAL.occurrences(daily, new Date(2026, 10, 1).getTime(), new Date(2026, 10, 30).getTime()).length, 3);
  const until = CAL.parseIcs(ics(ev('SUMMARY:Gym', 'DTSTART:20261101T180000', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261107T235959Z')));
  assert.deepStrictEqual(CAL.occurrences(until, new Date(2026, 10, 1).getTime(), new Date(2026, 10, 30).getTime()).map((e) => new Date(e.start).getDate()), [1, 3, 5, 7]);
  const second = CAL.parseIcs(ics(ev('SUMMARY:Review', 'DTSTART:20260113T150000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU')));
  assert.deepStrictEqual(titles(CAL.occurrences(second, ...day(2026, 11, 10))), ['Review'], '2nd Tuesday of November 2026 is the 10th');
  const last = CAL.parseIcs(ics(ev('SUMMARY:Payday', 'DTSTART:20260130T090000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR')));
  assert.deepStrictEqual(titles(CAL.occurrences(last, ...day(2026, 11, 27))), ['Payday'], 'last Friday of November 2026');
  const bday = CAL.parseIcs(ics(ev('SUMMARY:Birthday', 'DTSTART;VALUE=DATE:19950309', 'RRULE:FREQ=YEARLY')));
  assert.deepStrictEqual(titles(CAL.occurrences(bday, ...day(2027, 3, 9))), ['Birthday']);
});

test('moved occurrences (RECURRENCE-ID) and cancelled events', () => {
  const feed = CAL.parseIcs(ics(
    ev('UID:s1', 'SUMMARY:Standup', 'DTSTART:20261109T090000', 'RRULE:FREQ=DAILY'),
    ev('UID:s1', 'SUMMARY:Standup (moved)', 'RECURRENCE-ID:20261110T090000', 'DTSTART:20261110T140000'),
    ev('UID:x', 'SUMMARY:Off', 'DTSTART:20261110T100000', 'STATUS:CANCELLED'),
  ));
  assert.deepStrictEqual(titles(CAL.occurrences(feed, ...day(2026, 11, 10))), ['Standup (moved)']);
});

test('the calendar skill never leaks the private feed link', async () => {
  const secret = 'https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics';
  const ctx = (fetch) => ({ platform: 'linux', config: { calendarUrl: secret }, fetch, now: () => new Date(2026, 10, 9, 8) });
  const r1 = await SK.runSkill('calendar', 'today', ctx(async () => { throw new Error(`getaddrinfo ENOTFOUND for ${secret}`); }));
  assert.ok(r1.error && !r1.error.includes('private-abc123'));
  const r2 = await SK.runSkill('calendar', 'today', ctx(async () => ({ ok: false, status: 404 })));
  assert.match(r2.error, /HTTP 404/);
  assert.ok(!r2.error.includes('private'));
  const r3 = await SK.runSkill('calendar', 'today', ctx(async () => ({ ok: true, text: async () => ics(ev('SUMMARY:Standup', 'DTSTART:20261109T093000', 'RRULE:FREQ=DAILY')) })));
  assert.match(r3.result, /Standup/);
});
