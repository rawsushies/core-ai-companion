'use strict';

// File intelligence: turns a dropped file into text (and sometimes an image)
// COre can reason about. No extra dependencies: ZIP-based Office files, PDF
// text, spreadsheets, code, images, IFC (BIM) and DXF (CAD) are read here.
// Audio and video are decoded in the dock (Chromium's codecs) and come back as
// a transcript and a few frames. Everything extracted is untrusted data.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const GUARD = require('./guard');

const MAX_FILE = 200 * 1024 * 1024; // what we accept at all
const MAX_TEXT_READ = 60 * 1024 * 1024; // what we read into memory as text
const MAX_CHARS = 200000; // extracted text we keep per file

const EXT = {
  pdf: ['pdf'],
  doc: ['docx', 'odt'],
  sheet: ['xlsx', 'csv', 'tsv', 'ods'],
  slides: ['pptx', 'odp'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'ogv'],
  cad: ['dxf', 'dwg'],
  bim: ['ifc'],
  code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'ps1', 'bat', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'lua', 'r', 'dart', 'scala', 'pl', 'yaml', 'yml', 'toml', 'ini', 'xml', 'json', 'gradle', 'dockerfile', 'makefile'],
  text: ['txt', 'md', 'markdown', 'rst', 'log', 'rtf', 'tex', 'srt', 'vtt', 'env.example'],
};

function kindOf(name) {
  const base = path.basename(String(name)).toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return 'code';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  for (const [k, list] of Object.entries(EXT)) if (list.includes(ext)) return k;
  return 'other';
}

// ------------------------------------------------------------------ zip

// -> Map(name -> () => Buffer). Sizes are capped against zip bombs.
function unzip(buf, { maxEntry = 80 * 1024 * 1024 } = {}) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + clen;
    out.set(name, () => {
      if (usize > maxEntry) throw new Error(`${name} is too large`);
      const ln = buf.readUInt16LE(off + 26);
      const le = buf.readUInt16LE(off + 28);
      const data = buf.subarray(off + 30 + ln + le, off + 30 + ln + le + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: maxEntry });
      throw new Error(`unsupported zip method ${method}`);
    });
  }
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const read = (z, name) => { const f = z.get(name); return f ? f().toString('utf8') : ''; };

function docxText(buf) {
  const z = unzip(buf);
  const xml = read(z, 'word/document.xml') || read(z, 'content.xml'); // odt
  if (!xml) throw new Error('no document body found');
  const text = decodeXml(xml
    .replace(/<w:tab\/>|<text:tab\/>/g, '\t')
    .replace(/<\/w:p>|<\/text:p>|<\/text:h>|<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n').trim();
  const paragraphs = text.split(/\n+/).filter((l) => l.trim()).length;
  return { text, meta: { words: words(text), paragraphs } };
}

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

function xlsxText(buf, { maxRows = 300 } = {}) {
  const z = unzip(buf);
  const shared = [];
  const ss = read(z, 'xl/sharedStrings.xml');
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const wb = read(z, 'xl/workbook.xml');
  const rels = read(z, 'xl/_rels/workbook.xml.rels');
  const target = {};
  for (const m of rels.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) target[m[1]] = m[2];
  for (const m of rels.matchAll(/<Relationship [^>]*Target="([^"]+)"[^>]*Id="([^"]+)"/g)) target[m[2]] = m[1];
  const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: decodeXml(m[1]), file: `xl/${(target[m[2]] || '').replace(/^\/?xl\//, '')}` }));
  if (!sheets.length) for (const k of z.keys()) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) sheets.push({ name: k.match(/sheet\d+/)[0], file: k });
  const parts = [];
  const meta = { sheets: sheets.length, rows: 0 };
  for (const sh of sheets) {
    const xml = read(z, sh.file);
    const rows = [];
    let cols = 0;
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] || '';
        const ci = colIndex((/r="([A-Z]+\d+)"/.exec(attrs) || [])[1]);
        const t = (/t="(\w+)"/.exec(attrs) || [])[1];
        let v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        if (t === 's') v = shared[Number(v)];
        else if (t === 'inlineStr') v = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('');
        if (v !== undefined) row[ci >= 0 ? ci : row.length] = decodeXml(v);
      }
      cols = Math.max(cols, row.length);
      rows.push(row);
    }
    meta.rows += rows.length;
    const shown = rows.slice(0, maxRows).map((r) => Array.from({ length: r.length }, (_, i) => csvCell(r[i])).join(','));
    parts.push(`## Sheet "${sh.name}" (${rows.length} rows x ${cols} columns)\n${shown.join('\n')}${rows.length > maxRows ? `\n…(${rows.length - maxRows} more rows)` : ''}`);
  }
  return { text: parts.join('\n\n'), meta };
}

function csvText(raw, sep) {
  const lines = raw.split(/\r?\n/).filter((l) => l.length);
  const cols = lines.length ? lines[0].split(sep).length : 0;
  return { text: raw, meta: { rows: lines.length, columns: cols } };
}

function pptxText(buf) {
  const z = unzip(buf);
  const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
  const parts = slides.map((k, i) => {
    const xml = read(z, k);
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => decodeXml([...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join(''))).filter(Boolean);
    return `## Slide ${i + 1}\n${paras.join('\n')}`;
  });
  return { text: parts.join('\n\n'), meta: { slides: slides.length } };
}

// ------------------------------------------------------------------ pdf

function pdfString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === 'n') out += '\n'; else if (n === 'r') out += ''; else if (n === 't') out += '\t';
    else if (n === 'b' || n === 'f') out += '';
    else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(s[i + 1])) o += s[++i]; out += String.fromCharCode(parseInt(o, 8)); }
    else if (n === '\n' || n === '\r') { /* line continuation */ }
    else out += n;
  }
  return out;
}

function hexString(h) {
  const clean = h.replace(/\s+/g, '');
  const bytes = Buffer.from(clean.length % 2 ? `${clean}0` : clean, 'hex');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le');
  return bytes.toString('latin1');
}

// Text operators inside one content stream.
function pdfContentText(src) {
  let out = '';
  const re = /\((?:\\[\s\S]|[^\\)])*\)|<[0-9a-fA-F\s]+>|\[|\]|-?\d*\.?\d+|\/[^\s/<>()[\]]+|[A-Za-z'"*]+/g;
  let arr = null;
  const stack = [];
  let m;
  while ((m = re.exec(src))) {
    const t = m[0];
    if (t[0] === '(') { const s = pdfString(t.slice(1, -1)); (arr || stack).push(s); continue; }
    if (t[0] === '<') { const s = hexString(t.slice(1, -1)); (arr || stack).push(s); continue; }
    if (t === '[') { arr = []; continue; }
    if (t === ']') { stack.push(arr || []); arr = null; continue; }
    if (arr) { if (/^-?\d/.test(t) && Number(t) < -200) arr.push(' '); continue; }
    if (t === 'Tj' || t === "'" || t === '"') { if (t !== 'Tj') out += '\n'; out += String(stack.pop() ?? ''); stack.length = 0; continue; }
    if (t === 'TJ') { const a = stack.pop(); out += Array.isArray(a) ? a.join('') : ''; stack.length = 0; continue; }
    if (t === 'Td' || t === 'TD') { const ty = Number(stack[stack.length - 1]); if (ty) out += '\n'; else out += ' '; stack.length = 0; continue; }
    if (t === 'T*' || t === 'ET') { out += '\n'; stack.length = 0; continue; }
    if (t === 'Tm') { out += '\n'; stack.length = 0; continue; }
    if (/^[A-Za-z]/.test(t) && t[0] !== '/') stack.length = 0;
    else stack.push(t);
  }
  return out;
}

// pdf.js (Mozilla) for real-world PDFs: CID fonts, ToUnicode maps, object
// streams. Scripts in PDFs are never evaluated (isEvalSupported: false).
let pdfjsP = null;
async function pdfjsText(buf, { maxPages = 300 } = {}) {
  if (!pdfjsP) pdfjsP = import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await pdfjsP;
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
    cMapUrl: `${path.join(root, 'cmaps')}${path.sep}`, cMapPacked: true, standardFontDataUrl: `${path.join(root, 'standard_fonts')}${path.sep}`,
  }).promise;
  try {
    let text = '';
    const pages = doc.numPages;
    for (let i = 1; i <= Math.min(pages, maxPages); i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      text += `${pages > 1 ? `\n[page ${i}]\n` : ''}${tc.items.map((x) => `${x.str}${x.hasEOL ? '\n' : ''}`).join('')}\n`;
      page.cleanup();
      if (text.length > MAX_CHARS) break;
    }
    let title = '';
    try { const md = await doc.getMetadata(); title = (md.info && md.info.Title) || ''; } catch {}
    return { text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), pages, title };
  } finally { doc.destroy(); }
}

async function pdfTextBest(buf) {
  try {
    const r = await pdfjsText(buf);
    const meta = { pages: r.pages, ...(r.title ? { title: r.title } : {}) };
    const letters = (r.text.replace(/\[page \d+\]/g, '').match(/[\p{L}\p{N}]/gu) || []).length;
    if (letters < 20) return { text: '', meta: { ...meta, scanned: true }, note: 'This PDF has no text layer (it is probably scanned). Open it and ask COre to look at the screen.' };
    return { text: r.text, meta: { ...meta, words: words(r.text) } };
  } catch (err) {
    if (/password|encrypt/i.test(err.message || '')) throw new Error('This PDF is password protected.');
    return pdfText(buf); // simple built-in reader as a fallback
  }
}

function pdfText(buf) {
  const raw = buf.toString('latin1');
  if (!raw.startsWith('%PDF')) throw new Error('not a PDF');
  if (/\/Encrypt\s/.test(raw)) throw new Error('this PDF is encrypted');
  const pages = (raw.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  const title = (/\/Title\s*\(((?:\\[\s\S]|[^\\)])*)\)/.exec(raw) || [])[1];
  let text = '';
  const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[^<>]*>)*)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const lenM = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let end = lenM ? start + Number(lenM[1]) : raw.indexOf('endstream', start);
    if (end < start || end > raw.length) end = raw.indexOf('endstream', start);
    if (end < 0) break;
    re.lastIndex = end;
    if (/\/Subtype\s*\/(Image|Form)|\/Type\s*\/(XObject|XRef|ObjStm|Metadata)|\/Length1|\/FontFile/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) { try { data = zlib.inflateSync(data, { maxOutputLength: 20 * 1024 * 1024 }); } catch { try { data = zlib.inflateRawSync(data.subarray(2)); } catch { continue; } } }
    else if (/\/Filter/.test(dict)) continue; // other filters: skip
    const s = data.toString('latin1');
    if (!/BT[\s\S]*?ET/.test(s)) continue;
    for (const bt of s.matchAll(/BT([\s\S]*?)ET/g)) text += `${pdfContentText(bt[1])}\n`;
    if (text.length > MAX_CHARS * 2) break;
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  const readable = text.length ? letters / text.length : 0;
  const meta = { pages, ...(title ? { title: pdfString(title) } : {}) };
  if (text.length < 20 || readable < 0.45) return { text: '', meta: { ...meta, scanned: true }, note: 'This PDF has no readable text layer (it may be scanned or use embedded fonts). Ask COre to look at it on screen instead.' };
  return { text, meta: { ...meta, words: words(text) } };
}

// ------------------------------------------------------------------ CAD / BIM

function ifcSummary(raw) {
  const schema = (/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/.exec(raw) || [])[1] || 'unknown';
  const project = (/=\s*IFCPROJECT\s*\(\s*'[^']*'\s*,\s*[^,]*,\s*'([^']*)'/i.exec(raw) || [])[1] || '';
  const counts = {};
  for (const m of raw.matchAll(/=\s*(IFC[A-Z0-9]+)\s*\(/g)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  const storeys = [...raw.matchAll(/=\s*IFCBUILDINGSTOREY\s*\(\s*'[^']*'\s*,\s*[^,]*,\s*'([^']*)'(?:[^;]*?,\s*(-?[\d.E+-]+)\s*\)\s*;)?/gi)].map((m) => (m[2] ? `${decodeIfc(m[1])} (elevation ${Number(m[2])})` : decodeIfc(m[1])));
  const spaces = [...raw.matchAll(/=\s*IFCSPACE\s*\(\s*'[^']*'\s*,\s*[^,]*,\s*'([^']*)'\s*,\s*(?:'([^']*)'|\$)/gi)].map((m) => decodeIfc(m[1] + (m[2] ? ` ${m[2]}` : ''))).slice(0, 80);
  const materials = [...new Set([...raw.matchAll(/=\s*IFCMATERIAL\s*\(\s*'([^']*)'/gi)].map((m) => decodeIfc(m[1])))].slice(0, 40);
  const ELEMENTS = ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCSLAB', 'IFCROOF', 'IFCDOOR', 'IFCWINDOW', 'IFCCOLUMN', 'IFCBEAM', 'IFCSTAIR', 'IFCRAILING', 'IFCCURTAINWALL', 'IFCPLATE', 'IFCMEMBER', 'IFCCOVERING', 'IFCFURNISHINGELEMENT', 'IFCFLOWTERMINAL', 'IFCFLOWSEGMENT', 'IFCSPACE', 'IFCOPENINGELEMENT', 'IFCFOOTING', 'IFCPILE', 'IFCBUILDINGELEMENTPROXY'];
  const elements = ELEMENTS.filter((e) => counts[e]).map((e) => `${e.replace(/^IFC/, '').toLowerCase()}: ${counts[e]}`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const lines = [
    `IFC model (${schema})${project ? `, project "${decodeIfc(project)}"` : ''}. ${total} entities.`,
    `Storeys (${storeys.length}): ${storeys.join('; ') || 'none'}`,
    `Building elements: ${elements.join(', ') || 'none found'}`,
    ...(spaces.length ? [`Spaces (${counts.IFCSPACE || spaces.length}): ${spaces.join('; ')}`] : []),
    ...(materials.length ? [`Materials: ${materials.join(', ')}`] : []),
  ];
  return { text: lines.join('\n'), meta: { schema, storeys: storeys.length, elements: elements.length, entities: total } };
}

function decodeIfc(s) {
  return String(s).replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, h) => h.match(/.{4}/g).map((c) => String.fromCharCode(parseInt(c, 16))).join('')).replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/''/g, "'");
}

function dxfSummary(raw) {
  const lines = raw.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([lines[i].trim(), lines[i + 1].trim()]);
  const header = {};
  const layers = new Set();
  const entities = {};
  const texts = [];
  let section = '';
  let inEntities = false;
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === '0' && v === 'SECTION') { section = (pairs[i + 1] || [])[1] || ''; inEntities = section === 'ENTITIES'; continue; }
    if (c === '0' && v === 'ENDSEC') { section = ''; inEntities = false; continue; }
    if (section === 'HEADER' && c === '9') {
      const name = v;
      const vals = [];
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== '9' && pairs[j][0] !== '0'; j++) vals.push(pairs[j][1]);
      header[name] = vals.join(', ');
    }
    if (section === 'TABLES' && c === '0' && v === 'LAYER') { for (let j = i + 1; j < pairs.length && pairs[j][0] !== '0'; j++) if (pairs[j][0] === '2') { layers.add(pairs[j][1]); break; } }
    if (inEntities && c === '0') {
      entities[v] = (entities[v] || 0) + 1;
      if ((v === 'TEXT' || v === 'MTEXT') && texts.length < 120) {
        for (let j = i + 1; j < pairs.length && pairs[j][0] !== '0'; j++) if (pairs[j][0] === '1') { texts.push(pairs[j][1].replace(/\\P/g, ' ').replace(/\\[A-Za-z][^;]*;/g, '').replace(/[{}]/g, '')); break; }
      }
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== '0'; j++) if (pairs[j][0] === '8') { layers.add(pairs[j][1]); break; }
    }
  }
  const VER = { AC1009: 'R12', AC1015: '2000', AC1018: '2004', AC1021: '2007', AC1024: '2010', AC1027: '2013', AC1032: '2018' };
  const ver = header.$ACADVER;
  const ent = Object.entries(entities).sort((a, b) => b[1] - a[1]);
  const out = [
    `DXF drawing${ver ? ` (AutoCAD ${VER[ver] || ver})` : ''}. ${ent.reduce((a, [, n]) => a + n, 0)} entities on ${layers.size} layers.`,
    ...(header.$EXTMIN ? [`Extents: ${header.$EXTMIN} to ${header.$EXTMAX}`] : []),
    ...(header.$INSUNITS ? [`Units code: ${header.$INSUNITS}`] : []),
    `Entities: ${ent.map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ') || 'none'}`,
    `Layers: ${[...layers].slice(0, 80).join(', ') || 'none'}`,
    ...(texts.length ? [`Text in the drawing:\n${texts.join('\n')}`] : []),
  ];
  return { text: out.join('\n'), meta: { entities: ent.reduce((a, [, n]) => a + n, 0), layers: layers.size } };
}

// ------------------------------------------------------------------ images

function imageSize(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  if (buf.toString('ascii', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.toString('ascii', 8, 12) === 'WEBP' && buf.toString('ascii', 12, 16) === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  return null;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };

// ------------------------------------------------------------------ main entry

function words(t) { return (String(t).match(/\S+/g) || []).length; }
function looksBinary(buf) { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }

// -> { kind, text, meta, image?, needsMedia?, note? }. Throws with a plain message.
// deps.resizeImage(buf) -> { base64, mediaType } shrinks large images (Electron nativeImage).
async function extract(file, deps = {}) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('Folders are not supported; drop the files.');
  if (st.size > MAX_FILE) throw new Error('Files over 200 MB are not supported.');
  const kind = kindOf(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  if (kind === 'audio' || kind === 'video') return { kind, text: '', meta: {}, needsMedia: true };
  if (ext === 'dwg') throw new Error('DWG is a closed format. Save it as DXF (or IFC) and drop that.');
  if (kind === 'image') {
    const buf = fs.readFileSync(file);
    const size = imageSize(buf) || {};
    let image = { base64: buf.toString('base64'), mediaType: MIME[ext] || 'image/png' };
    if ((buf.length > 3.5 * 1024 * 1024 || ext === 'bmp' || (size.width || 0) > 2400 || (size.height || 0) > 2400) && deps.resizeImage) image = deps.resizeImage(buf, MIME[ext]) || image;
    return { kind, text: '', meta: { ...size }, image };
  }
  const big = ['pdf', 'doc', 'slides'].includes(kind) || ext === 'xlsx' || ext === 'ods';
  if (big) {
    const buf = fs.readFileSync(file);
    let r;
    if (kind === 'pdf') r = await pdfTextBest(buf);
    else if (kind === 'doc') r = docxText(buf);
    else if (kind === 'slides') r = pptxText(buf);
    else r = ext === 'ods' ? docxText(buf) : xlsxText(buf);
    return { kind, ...r, text: cap(r.text) };
  }
  if (st.size > MAX_TEXT_READ) throw new Error('Text files over 60 MB are not supported.');
  const buf = fs.readFileSync(file);
  if (kind === 'other' && looksBinary(buf)) throw new Error('This kind of file is not supported yet.');
  const raw = buf.toString('utf8').replace(/^﻿/, '');
  if (kind === 'bim') return { kind, ...ifcSummary(raw) };
  if (kind === 'cad') return { kind, ...dxfSummary(raw) };
  if (ext === 'csv' || ext === 'tsv') { const r = csvText(raw, ext === 'tsv' ? '\t' : ','); return { kind, ...r, text: cap(r.text) }; }
  const lines = raw.split('\n').length;
  return { kind: kind === 'other' ? 'text' : kind, text: cap(raw), meta: { lines, words: words(raw), ...(kind === 'code' ? { language: ext } : {}) } };
}

function cap(t) { t = String(t || ''); return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}\n…(the rest is cut)` : t; }

function describeMeta(kind, m = {}) {
  const n = (v, w) => `${Number(v).toLocaleString('en-US')} ${w}${v === 1 ? '' : 's'}`;
  const bits = [];
  if (m.pages) bits.push(n(m.pages, 'page'));
  if (m.slides) bits.push(n(m.slides, 'slide'));
  if (m.sheets) bits.push(n(m.sheets, 'sheet'));
  if (m.rows) bits.push(n(m.rows, 'row'));
  if (m.storeys !== undefined && kind === 'bim') bits.push(n(m.storeys, 'storey'), n(m.entities, 'entity').replace('entitys', 'entities'));
  if (m.layers !== undefined && kind === 'cad') bits.push(n(m.entities, 'entity').replace('entitys', 'entities'), n(m.layers, 'layer'));
  if (m.width) bits.push(`${m.width}×${m.height}`);
  if (m.duration) bits.push(`${Math.floor(m.duration / 60)}:${String(Math.round(m.duration % 60)).padStart(2, '0')}`);
  if (m.lines && !m.pages) bits.push(n(m.lines, 'line'));
  if (m.words && !m.lines) bits.push(n(m.words, 'word'));
  if (m.scanned) bits.push('no text layer');
  return bits.join(' · ');
}

// ------------------------------------------------------------------ the shelf

// The files you dropped: an index plus extracted text, kept in userData/files.
class FileShelf {
  constructor({ dir, maxItems = 40 }) {
    this.dir = dir;
    this.maxItems = maxItems;
    fs.mkdirSync(dir, { recursive: true });
    this.indexFile = path.join(dir, 'index.json');
    try { this.items = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { this.items = []; }
    for (const it of this.items) if (it.status === 'reading') { it.status = 'error'; it.error = 'Interrupted. Drop it again.'; }
  }

  _save() { const tmp = `${this.indexFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.items, null, 1)); fs.renameSync(tmp, this.indexFile); }
  _text(id) { return path.join(this.dir, `${id}.txt`); }
  _img(id) { return path.join(this.dir, `${id}.img.json`); }
  get(id) { return this.items.find((i) => i.id === id) || null; }
  list() { return this.items.map((i) => ({ ...i, info: describeMeta(i.kind, i.meta) })); }

  // Adds a card at once (status reading) and extracts in the background.
  async add(file, deps = {}) {
    const st = fs.statSync(file);
    const it = { id: crypto.randomBytes(6).toString('hex'), name: path.basename(file), path: file, size: st.size, kind: kindOf(file), added: Date.now(), status: 'reading', meta: {} };
    this.items.unshift(it);
    while (this.items.length > this.maxItems) this.remove(this.items[this.items.length - 1].id);
    this._save();
    if (deps.onChange) deps.onChange();
    try {
      const r = await extract(file, deps);
      it.kind = r.kind;
      it.meta = r.meta || {};
      if (r.note) it.note = r.note;
      if (r.text) fs.writeFileSync(this._text(it.id), r.text);
      if (r.image) fs.writeFileSync(this._img(it.id), JSON.stringify(r.image));
      it.chars = r.text ? r.text.length : 0;
      it.hasImage = !!r.image;
      it.status = r.needsMedia ? 'media' : 'ready';
      const g = r.text ? GUARD.scan(r.text) : [];
      if (g.length) it.flags = g;
    } catch (err) {
      it.status = 'error';
      it.error = String(err.message || err).slice(0, 200);
    }
    this._save();
    if (deps.onChange) deps.onChange();
    return it;
  }

  // Audio/video results from the dock: a transcript and/or a few frames.
  setMedia(id, { transcript = '', frames = [], duration = 0, error = '' } = {}) {
    const it = this.get(id);
    if (!it) return null;
    if (error && !transcript && !frames.length) { it.status = 'error'; it.error = String(error).slice(0, 200); this._save(); return it; }
    const parts = [];
    if (transcript) parts.push(`Transcript:\n${transcript}`);
    if (frames.length) parts.push(`(${frames.length} frames from the video are attached as images.)`);
    if (!transcript && it.kind === 'audio') parts.push('(No speech was recognised.)');
    const text = parts.join('\n\n');
    fs.writeFileSync(this._text(id), text);
    if (frames[0]) fs.writeFileSync(this._img(id), JSON.stringify({ base64: frames[Math.floor(frames.length / 2)] || frames[0], mediaType: 'image/jpeg' }));
    it.chars = text.length;
    it.hasImage = !!frames[0];
    it.meta = { ...it.meta, duration, words: words(transcript) };
    it.status = 'ready';
    this._save();
    return it;
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    for (const f of [this._text(id), this._img(id)]) try { fs.unlinkSync(f); } catch {}
    this._save();
    return true;
  }

  text(id) { try { return fs.readFileSync(this._text(id), 'utf8'); } catch { return ''; } }
  image(id) { try { return JSON.parse(fs.readFileSync(this._img(id), 'utf8')); } catch { return null; } }

  // Context for the brain: each file fenced as untrusted, within a budget.
  // -> { block, image, flags, names }
  contextFor(ids, { budget = 30000 } = {}) {
    const items = ids.map((id) => this.get(id)).filter((i) => i && i.status === 'ready');
    if (!items.length) return null;
    const per = Math.max(2000, Math.floor(budget / items.length));
    const flags = new Set();
    const parts = items.map((it) => {
      let t = this.text(it.id);
      if (t.length > per) t = `${t.slice(0, per)}\n…(cut: ${t.length - per} more characters)`;
      const g = GUARD.untrusted(t || `(no text: ${it.note || 'see the attached image'})`, `file ${it.name}`);
      g.flags.forEach((f) => flags.add(f));
      const info = describeMeta(it.kind, it.meta);
      return `File "${it.name}" (${it.kind}${info ? `, ${info}` : ''}):\n${g.text}`;
    });
    const withImage = items.find((i) => i.hasImage);
    return { block: `[Files] The user attached ${items.length === 1 ? 'a file' : `${items.length} files`}. Use them to answer.\n\n${parts.join('\n\n')}`, image: withImage ? this.image(withImage.id) : null, imageName: withImage ? withImage.name : '', flags: [...flags], names: items.map((i) => i.name) };
  }
}

module.exports = { kindOf, unzip, decodeXml, docxText, xlsxText, pptxText, pdfText, pdfTextBest, pdfContentText, ifcSummary, dxfSummary, imageSize, extract, describeMeta, FileShelf, EXT };
