'use strict';

// Tiny local endpoint so anything on this PC (a script, a build, a cron job)
// can ask for COre's attention:
//
//   curl -X POST http://127.0.0.1:47321/notify \
//     -H "Authorization: Bearer <token from config.json>" \
//     -H "content-type: application/json" \
//     -d '{"title":"Build finished","level":"success"}'
//
// Bound to 127.0.0.1 only and every request needs the per-install token, so a
// web page in your browser cannot trigger it (it cannot know the token).

const http = require('http');
const { timingSafeEqual } = require('crypto');

const LEVELS = new Set(['info', 'success', 'warn', 'urgent']);
const MAX_BODY = 16 * 1024;

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readToken(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : req.headers['x-core-token'];
}

function normalize(body) {
  const title = String(body.title || '').trim().slice(0, 140);
  if (!title) return null;
  return {
    title,
    body: String(body.body || '').trim().slice(0, 600),
    level: LEVELS.has(body.level) ? body.level : 'info',
    speak: body.speak === true,
  };
}

function startNotifyServer({ port, token, onNotify, host = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, app: 'core' });
    if (req.method !== 'POST' || req.url !== '/notify') return send(404, { error: 'not found' });
    if (!tokenMatches(readToken(req), token)) return send(401, { error: 'bad or missing token' });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(413, { error: 'too large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return send(400, { error: 'invalid json' });
      }
      const n = normalize(body);
      if (!n) return send(400, { error: 'title is required' });
      onNotify(n);
      send(200, { ok: true });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { startNotifyServer, normalize, tokenMatches };
