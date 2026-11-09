'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CrashLog } = require('../src/main/crashlog');
const { persona, toneKey } = require('../src/main/brain/persona');
const { validate } = require('../src/main/settingsSchema');

test('crash log records locally, keeps the newest, survives garbage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-crash-'));
  const log = new CrashLog(dir);
  assert.deepStrictEqual(log.recent(), []);
  log.record('main-exception', new Error('boom'));
  log.record('webgl', 'WebGL2 is not available');
  fs.appendFileSync(log.file, 'not json\n');
  const r = log.recent(5);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[1].kind, 'webgl');
  assert.match(r[0].detail, /boom/);
});

test('reply language reaches the persona safely', () => {
  assert.strictEqual(toneKey('calm', ''), 'calm');
  assert.strictEqual(toneKey('calm', 'Bahasa Indonesia'), 'calm@Bahasa Indonesia');
  assert.strictEqual(toneKey('calm', 'X" & del'), 'calm@X  del');
  const p = persona({ tone: toneKey('dramatic', 'Japanese') });
  assert.ok(p.includes('Always reply in Japanese'));
  assert.ok(p.includes('cinematic'), 'tone still applied');
  assert.ok(persona({ tone: 'calm' }).includes('language the user speaks'));
});

test('new polish settings validate', () => {
  assert.strictEqual(validate('orb.theme', 'ember'), 'ember');
  assert.strictEqual(validate('orb.theme', 'neon'), undefined);
  assert.strictEqual(validate('orb.profile', 'battery'), 'battery');
  assert.strictEqual(validate('a11y.reduceMotion', 'on'), 'on');
  assert.strictEqual(validate('personality.language', ''), '');
  assert.strictEqual(validate('personality.language', 'Klingon'), undefined);
});
