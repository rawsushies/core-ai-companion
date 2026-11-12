'use strict';

// Renders the README art (assets/brand/readme/src/readme.html) to PNGs at 2x:
//   node scripts/brand/render-readme.js
// Each <section class="art" id="X"> becomes assets/brand/readme/X.png.

const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const dir = path.join(__dirname, '..', '..', 'assets', 'brand', 'readme');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`file://${path.join(dir, 'src', 'readme.html')}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  for (const el of await page.$$('section.art')) {
    const id = await el.getAttribute('id');
    await el.screenshot({ path: path.join(dir, `${id}.png`) });
    console.log(`wrote assets/brand/readme/${id}.png`);
  }
  await browser.close();
})().catch((err) => { console.error(err); process.exit(1); });
