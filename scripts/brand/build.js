'use strict';

// Builds COre's brand kit into assets/brand/ (and the app/tray icons):
//   node scripts/brand/build.js
// Logo marks are generated SVG; banners are HTML laid out with real renders
// of COre's smoke (assets/brand/renders, captured from the orb demo page)
// and rasterised with the bundled Chromium (Playwright).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { markSvg, glyphSvg } = require('./mark');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'assets', 'brand');
const R = path.join(OUT, 'renders');
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'core-brand-'));

const C = {
  void: '#05070A', smoke: '#0B1F15', emerald: '#3DFF85', mint: '#7DFFB0', ink: '#E8FFF1', muted: '#86A595',
  ice: '#40CCFF', ember: '#FF7A24', violet: '#B475FF',
};

const dataUri = (file) => `data:image/${file.endsWith('.svg') ? 'svg+xml' : file.endsWith('.png') ? 'png' : 'jpeg'};base64,${fs.readFileSync(file).toString('base64')}`;
const render = (name) => dataUri(path.join(R, `orb-${name}.jpg`));

const BASE_CSS = `
  * { margin: 0; box-sizing: border-box; }
  html, body { background: ${C.void}; color: ${C.ink}; font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }
  .display { font-family: 'Inter Display', 'Inter', sans-serif; letter-spacing: -0.03em; }
  .mono { font-family: 'JetBrains Mono', monospace; }
  .orb { position: absolute; mix-blend-mode: screen; }
  .grain { position: absolute; inset: 0; background: radial-gradient(ellipse at 70% 50%, rgba(61,255,133,0.10), transparent 60%); }
`;

function wordmark(sizePx, markUri, color = C.ink) {
  // "COre": the O is the orb.
  return `<span class="display" style="display:inline-flex;align-items:center;font-weight:600;font-size:${sizePx}px;line-height:1;color:${color}">C<img src="${markUri}" style="width:${sizePx * 0.92}px;height:${sizePx * 0.92}px;margin:0 ${sizePx * -0.04}px 0 ${sizePx * -0.02}px;transform:translateY(${sizePx * 0.02}px)">re</span>`;
}

async function shoot(page, file, html, w, h, { transparent = false } = {}) {
  const doc = path.join(TMP, `${path.basename(file)}.html`);
  fs.writeFileSync(doc, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS} ${transparent ? 'html,body{background:transparent}' : ''}</style></head><body style="width:${w}px;height:${h}px;position:relative;overflow:hidden">${html}</body></html>`);
  await page.setViewportSize({ width: w, height: h });
  await page.goto(`file://${doc}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: file, omitBackground: transparent });
}

(async () => {
  // ---- vector marks
  fs.writeFileSync(path.join(OUT, 'logo-mark.svg'), markSvg({ size: 512 }));
  fs.writeFileSync(path.join(OUT, 'logo-mark-tile.svg'), markSvg({ size: 512, bg: true }));
  fs.writeFileSync(path.join(OUT, 'logo-glyph.svg'), glyphSvg({ size: 64 }));
  const markUri = dataUri(path.join(OUT, 'logo-mark.svg'));
  const tileUri = dataUri(path.join(OUT, 'logo-mark-tile.svg'));

  const br = await chromium.launch();
  const page = await br.newPage({ deviceScaleFactor: 1 });
  const png = (name) => path.join(OUT, name);

  // ---- icons
  for (const s of [1024, 512, 256, 128]) {
    await shoot(page, png(`icon-${s}.png`), `<img src="${tileUri}" style="width:${s}px;height:${s}px;display:block">`, s, s, { transparent: true });
  }
  fs.copyFileSync(png('icon-512.png'), path.join(ROOT, 'assets', 'icon.png')); // app + installer icon
  for (const [s, f] of [[16, 'tray.png'], [32, 'tray@2x.png']]) {
    const g = dataUri(path.join(OUT, 'logo-glyph.svg'));
    await shoot(page, path.join(ROOT, 'assets', f), `<img src="${g}" style="width:${s}px;height:${s}px;display:block">`, s, s, { transparent: true });
  }
  await shoot(page, png('logo-mark.png'), `<img src="${markUri}" style="width:1024px;height:1024px">`, 1024, 1024, { transparent: true });

  // ---- wordmarks
  await shoot(page, png('wordmark.png'), `<div style="padding:40px 60px">${wordmark(220, markUri)}</div>`, 900, 300, { transparent: true });
  await shoot(page, png('wordmark-dark.png'), `<div style="height:100%;display:flex;align-items:center;justify-content:center">${wordmark(200, markUri)}</div>`, 1000, 360);

  // ---- README banner 1280x400
  await shoot(page, png('banner-readme.png'), `
    <div class="grain"></div>
    <img class="orb" src="${render('wave')}" style="right:60px;top:-70px;width:600px">
    <div style="position:absolute;left:84px;top:86px">
      ${wordmark(132, markUri)}
      <div class="display" style="font-size:38px;font-weight:500;margin-top:22px;color:${C.ink}">Your desktop companion, made of smoke.</div>
      <div style="font-size:20px;margin-top:16px;color:${C.muted}">Talks · listens · gestures · shape-shifts · runs on your own Claude login</div>
    </div>`, 1280, 400);

  // ---- GitHub social preview 1280x640
  await shoot(page, png('social-preview.png'), `
    <div class="grain" style="background:radial-gradient(ellipse at 50% 38%, rgba(61,255,133,0.14), transparent 55%)"></div>
    <img class="orb" src="${render('idle')}" style="left:390px;top:-60px;width:500px">
    <div style="position:absolute;left:0;right:0;top:410px;text-align:center">
      ${wordmark(110, markUri)}
      <div class="display" style="font-size:32px;font-weight:500;margin-top:18px">A companion that lives on your desktop.</div>
    </div>`, 1280, 640);

  // ---- feature promo 1200x628
  const tile = (img, title, sub, extra = '') => `
    <div style="position:relative;width:258px;height:330px;border-radius:22px;background:linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015));border:1px solid rgba(125,255,176,0.14);overflow:hidden">
      ${extra || `<img class="orb" src="${img}" style="left:-31px;top:-40px;width:320px">`}
      <div style="position:absolute;left:22px;right:18px;bottom:22px">
        <div class="display" style="font-size:25px;font-weight:600">${title}</div>
        <div style="font-size:15px;color:${C.muted};margin-top:6px;line-height:1.35">${sub}</div>
      </div>
    </div>`;
  const trio = `
    <img class="orb" src="${render('ice')}" style="left:-30px;top:0px;width:180px">
    <img class="orb" src="${render('idle')}" style="left:45px;top:-40px;width:180px">
    <img class="orb" src="${render('ember')}" style="left:110px;top:30px;width:180px">`;
  await shoot(page, png('promo-features.png'), `
    <div class="grain" style="background:radial-gradient(ellipse at 20% 0%, rgba(61,255,133,0.12), transparent 55%)"></div>
    <div style="position:absolute;left:56px;top:46px;display:flex;align-items:center;gap:22px">
      <img src="${markUri}" style="width:70px;height:70px">
      <div>
        <div class="display" style="font-size:42px;font-weight:600">Not a chatbot. A presence.</div>
        <div style="font-size:19px;color:${C.muted};margin-top:4px">COre floats on your desktop and actually reacts.</div>
      </div>
    </div>
    <div style="position:absolute;left:56px;top:226px;display:flex;gap:20px">
      ${tile(render('speaking'), 'Talks back', 'A deep robotic voice, in sync with every word.')}
      ${tile(render('thumbsup'), '30 gestures', 'Smoke hands that wave, count, shrug and point.')}
      ${tile(render('laugh'), 'Shape-shifts', 'Laughs at its own jokes. In smoke.')}
      ${tile('', 'Multitasks', 'Splits into helpers that work in parallel.', trio)}
    </div>`, 1200, 628);

  // ---- X / Twitter header 1500x500
  await shoot(page, png('promo-header.png'), `
    <div class="grain" style="background:radial-gradient(ellipse at 75% 50%, rgba(61,255,133,0.10), transparent 60%)"></div>
    <img class="orb" src="${render('violet')}" style="left:830px;top:20px;width:430px">
    <img class="orb" src="${render('celebrate')}" style="left:990px;top:-40px;width:500px">
    <img class="orb" src="${render('ice')}" style="left:1180px;top:60px;width:420px">
    <div style="position:absolute;left:96px;top:150px">
      ${wordmark(118, markUri)}
      <div class="display" style="font-size:34px;font-weight:500;margin-top:18px">Many COres. One desktop.</div>
      <div class="mono" style="font-size:17px;color:${C.mint};margin-top:18px">"Hey COre"  ·  Ctrl+Alt+Space</div>
    </div>`, 1500, 500);

  // ---- square promo 1080x1080
  await shoot(page, png('promo-square.png'), `
    <div class="grain" style="background:radial-gradient(ellipse at 50% 40%, rgba(61,255,133,0.13), transparent 55%)"></div>
    <img class="orb" src="${render('laugh')}" style="left:90px;top:10px;width:900px">
    <div style="position:absolute;left:0;right:0;bottom:120px;text-align:center">
      <div class="display" style="font-size:66px;font-weight:600;line-height:1.05">It laughs at its own jokes.</div>
      <div class="display" style="font-size:66px;font-weight:600;line-height:1.05;color:${C.emerald}">In smoke.</div>
    </div>
    <div style="position:absolute;left:0;right:0;bottom:44px;text-align:center">${wordmark(44, markUri, C.muted)}</div>`, 1080, 1080);

  // ---- story / vertical 1080x1920
  await shoot(page, png('promo-story.png'), `
    <div class="grain" style="background:radial-gradient(ellipse at 50% 30%, rgba(61,255,133,0.14), transparent 50%)"></div>
    <div style="position:absolute;left:0;right:0;top:150px;text-align:center">${wordmark(120, markUri)}</div>
    <img class="orb" src="${render('heart')}" style="left:40px;top:330px;width:1000px">
    <div style="position:absolute;left:90px;right:90px;top:1270px">
      <div class="display" style="font-size:96px;font-weight:600;line-height:1.02">Pet it. Poke it.<br><span style="color:${C.emerald}">Toss it.</span></div>
      <div style="font-size:40px;color:${C.muted};margin-top:36px;line-height:1.35">A smoke companion that talks, listens, gestures and helps, right on your desktop.</div>
      <div class="mono" style="font-size:30px;color:${C.mint};margin-top:50px">Free · Windows · runs on your Claude login</div>
    </div>`, 1080, 1920);

  // ---- colour palette swatch (for the brand guide)
  const sw = (name, hex, dark) => `<div style="width:180px"><div style="height:140px;border-radius:18px;background:${hex};border:1px solid rgba(255,255,255,0.08)"></div><div class="display" style="font-size:20px;font-weight:600;margin-top:12px">${name}</div><div class="mono" style="font-size:15px;color:${C.muted}">${hex}</div></div>`;
  await shoot(page, png('palette.png'), `<div style="padding:50px;display:flex;gap:24px;flex-wrap:wrap">
    ${sw('Void', C.void)}${sw('Smoke', C.smoke)}${sw('Emerald', C.emerald)}${sw('Mint', C.mint)}${sw('Ink', C.ink)}${sw('Muted', C.muted)}
    ${sw('Ice', C.ice)}${sw('Ember', C.ember)}${sw('Violet', C.violet)}</div>`, 1280, 560);

  await br.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('brand kit written to', OUT);
})();
