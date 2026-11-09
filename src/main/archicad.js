'use strict';

// Archicad proof of concept (Phase 5): READ-ONLY access to a running Archicad
// through its built-in JSON API on 127.0.0.1 (default port 19723; instances
// use 19723-19743). Only commands that read the model are exposed. Untested
// against a real Archicad: command availability varies by version.

const PORTS = Array.from({ length: 21 }, (_, i) => 19723 + i);
const TYPES = ['Wall', 'Column', 'Beam', 'Window', 'Door', 'Object', 'Lamp', 'Slab', 'Roof', 'Mesh', 'Zone', 'CurtainWall', 'Shell', 'Skylight', 'Morph', 'Stair', 'Railing', 'Opening'];
const READ_ONLY = new Set(['API.IsAlive', 'API.GetProductInfo', 'API.GetElementsByType']);

async function call(fetchImpl, port, command, parameters, timeoutMs = 2500) {
  if (!READ_ONLY.has(command)) throw new Error(`refusing ${command}: only read-only commands are allowed`);
  const res = await fetchImpl(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parameters ? { command, parameters } : { command }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (!j || j.succeeded !== true) throw new Error((j && j.error && j.error.message) || `${command} failed`);
  return j.result;
}

async function findArchicad(fetchImpl) {
  for (const port of PORTS) {
    try {
      const r = await call(fetchImpl, port, 'API.IsAlive', null, 600);
      if (r && r.isAlive) return port;
    } catch {}
  }
  return null;
}

// args: "status" | "count Door" -> { result } | { error }
async function archicadSkill(args, fetchImpl) {
  const [verb, ...rest] = String(args || 'status').trim().split(/\s+/);
  const port = await findArchicad(fetchImpl);
  if (!port) return { error: 'No running Archicad answered on 127.0.0.1 ports 19723-19743. Open a project in Archicad first.' };
  if (/^status$/i.test(verb || 'status')) {
    try {
      const p = await call(fetchImpl, port, 'API.GetProductInfo');
      return { result: `Archicad ${p.version || ''}${p.buildNumber ? ` build ${p.buildNumber}` : ''}${p.languageCode ? ` (${p.languageCode})` : ''} is running on port ${port}.` };
    } catch {
      return { result: `Archicad is running on port ${port}.` };
    }
  }
  if (/^count$/i.test(verb)) {
    const want = String(rest.join(' ') || '').replace(/s$/i, '').toLowerCase();
    const type = TYPES.find((t) => t.toLowerCase() === want);
    if (!type) return { error: `Unknown element type "${rest.join(' ')}". Try one of: ${TYPES.join(', ')}.` };
    const r = await call(fetchImpl, port, 'API.GetElementsByType', { elementType: type });
    const n = Array.isArray(r && r.elements) ? r.elements.length : 0;
    return { result: `The open Archicad project has ${n} ${type.toLowerCase()} element${n === 1 ? '' : 's'}.` };
  }
  return { error: 'The Archicad skill can do: status, or count TYPE (for example count Door). It never changes the model.' };
}

module.exports = { archicadSkill, findArchicad, call, TYPES, READ_ONLY, PORTS };
