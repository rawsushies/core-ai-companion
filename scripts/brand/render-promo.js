'use strict';
// Renders assets/brand/v11/src/promo.html frame by frame (the page is a pure
// function of time) and pipes the frames to ffmpeg.
//   node scripts/brand/render-promo.js out.mp4 [fps] [--stills t1,t2,... dir]
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

(async () => {
  const out = process.argv[2];
  const fps = Number(process.argv[3]) || 30;
  const DUR = 30;
  const stillsAt = process.argv.indexOf('--stills');
  const br = await chromium.launch();
  const page = await br.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(__dirname, '..', '..', 'assets', 'brand', 'v11', 'src', 'promo.html'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  if (stillsAt > 0) {
    for (const t of process.argv[stillsAt + 1].split(',').map(Number)) {
      await page.evaluate((t) => window.render(t), t);
      await page.screenshot({ path: path.join(process.argv[stillsAt + 2], `promo-${String(t).replace('.', '_')}.jpg`), type: 'jpeg', quality: 80 });
    }
    await br.close();
    return;
  }
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = DUR * fps;
  for (let f = 0; f < total; f++) {
    await page.evaluate((t) => window.render(t), f / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 150 === 0) console.log(`frame ${f}/${total}`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('exit', r));
  await br.close();
})().catch((e) => { console.error(e); process.exit(1); });
