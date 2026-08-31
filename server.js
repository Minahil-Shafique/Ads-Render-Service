/**
 * Ads Engine v2 — Compositor render service
 * Implements the POST /render interface from section 4 of the build spec.
 *
 * Scope note: this covers Phase 1 only — compositing text/branding onto a
 * plate that already exists. It does NOT decide where this runs in
 * production (VPS Docker container vs. hosted API) — that is one of
 * Sami's open questions in section 12 and is a deploy-time choice, not a
 * code change. Run it anywhere Node + Chrome can run; point n8n's HTTP
 * Request node at whichever host you land on.
 *
 * Usage:
 *   npm install
 *   node server.js
 *   POST http://localhost:3000/render  (see README section below)
 */

const express = require('express');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '15mb' }));

// Once this is on a public VPS domain via Traefik, anyone who finds the
// URL can call /render otherwise. A shared secret in a header is the
// minimum bar — set RENDER_API_KEY on the container and put the same
// value in n8n's HTTP Request node headers.
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const expected = process.env.RENDER_API_KEY;
  if (!expected) return next(); // not set — auth disabled, dev/local use only
  if (req.get('x-api-key') !== expected) {
    return res.status(401).json({ error: 'missing or invalid x-api-key header' });
  }
  next();
});

const ANTON = 'data:font/ttf;base64,' + fs.readFileSync(path.join(__dirname, 'Anton.ttf')).toString('base64');
const INTER = 'data:font/ttf;base64,' + fs.readFileSync(path.join(__dirname, 'Inter.ttf')).toString('base64');
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');

const CANVAS = 1024;

// One shared browser instance across requests instead of relaunching
// Chrome per render — relaunching per call is the main latency cost in
// a headless-Chrome renderer.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      // --disable-dev-shm-usage avoids a common Docker crash: containers
      // default to a tiny 64MB /dev/shm, and Chrome runs out of shared
      // memory on real-sized renders without this flag.
    });
  }
  return browserPromise;
}

// ---------- fetch a plate from a URL or a local path ----------
async function fetchBuffer(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  // Allow local/dev testing with a plain file path.
  return fs.readFileSync(url);
}

/**
 * Branding strip detection + carve fallback, per spec section 4:
 *   1. Scan rows bottom-up. A row is "clean" if mean brightness > 225
 *      AND std deviation < 14. Stop at the first row that is NOT clean —
 *      that is strip_top.
 *   2. If the detected clean strip is under 10% of image height, the
 *      model did not leave one — carve 13.5% of height, anchored to the
 *      bottom, instead.
 * Returns the strip height as a fraction of total image height (0 if
 * no branding requested — caller skips this function entirely then).
 */
async function detectOrCarveStripFraction(plateBuffer) {
  const img = sharp(plateBuffer).ensureAlpha(false);
  const meta = await img.metadata();
  const width = meta.width;
  const height = meta.height;

  // Downscale row analysis to a fixed sample width for speed; brightness
  // and std-dev statistics are resolution-independent for this purpose.
  const { data } = await img
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = meta.channels; // 3 (RGB) typically after ensureAlpha(false)

  function rowStats(y) {
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      // Perceptual-ish luminance from RGB.
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += lum;
      sumSq += lum * lum;
      n++;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    const std = Math.sqrt(Math.max(variance, 0));
    return { mean, std };
  }

  let cleanRows = 0;
  for (let y = height - 1; y >= 0; y--) {
    const { mean, std } = rowStats(y);
    const clean = mean > 225 && std < 14;
    if (!clean) break;
    cleanRows++;
  }

  const detectedFraction = cleanRows / height;

  if (detectedFraction < 0.10) {
    return 0.135; // carve fallback, anchored to the bottom
  }
  return detectedFraction;
}

/**
 * Paint the strip zone pure white with a 2px hairline rule along its
 * top edge. This is only meaningful when the plate wasn't already
 * generated with the strip reserved — it guarantees a clean, opaque
 * strip regardless of what the model put there.
 */
async function paintStripWhite(plateBuffer, stripPx, width, height) {
  const stripTop = height - stripPx;
  const overlaySvg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="${stripTop}" width="${width}" height="${stripPx}" fill="#FFFFFF" />
      <rect x="0" y="${stripTop}" width="${width}" height="2" fill="#E2E5E9" />
    </svg>`);
  return sharp(plateBuffer)
    .composite([{ input: overlaySvg, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/**
 * Trim a logo's own padding/margin so alignment in the strip is exact.
 * Spec calls for a bounding box on pixels with mean < 235; sharp's
 * built-in trim() is a close approximation of the same idea (trims
 * uniform near-white background), which is what's implemented here.
 * If a logo has a busy or non-white background, swap this for a real
 * per-pixel bounding-box scan.
 */
async function trimLogo(logoBuffer) {
  return sharp(logoBuffer).trim({ threshold: 20 }).png().toBuffer();
}

function stripHtml(brand, logoDataUri) {
  if (!brand) return '';
  return `<div class="strip"><img src="${logoDataUri}"><div class="who"><div class="nm">${escapeHtml(brand.name)}</div><div class="bk">${escapeHtml(brand.brokerage)}</div></div></div>`;
}

function featuresHtml(features) {
  if (!features || !features.length) return '';
  return `<div class="features">${features.map(f => `<div class="feat">${escapeHtml(f)}</div>`).join('')}</div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function body(v, plateDataUri, stripDiv, featDiv) {
  if (v.layout === 'A') return `
    <div class="panel"><div class="eyebrow dark">${escapeHtml(v.eyebrow)}</div><div class="headline">${escapeHtml(v.headline)}</div></div>
    <div class="photo"><img src="${plateDataUri}"></div>${featDiv}${stripDiv}`;
  if (v.layout === 'B') return `
    <div class="art">
      <div class="left">
        ${v.eyebrow ? `<div class="eyebrow">${escapeHtml(v.eyebrow)}</div>` : ''}
        <div class="headline">${escapeHtml(v.headline)}</div>
        <div class="sub">${escapeHtml(v.subline)}</div>
        <div><span class="btn">${escapeHtml(v.ctaText)}</span></div>
      </div>
      <div class="right"><img src="${plateDataUri}"></div>
    </div>${stripDiv}`;
  // layout C — full bleed
  return `
    <div class="art"><img class="plate" src="${plateDataUri}"></div>
    <div class="stack">
      <div class="eyebrow">${escapeHtml(v.eyebrow)}</div>
      <div class="headline">${escapeHtml(v.headline)}</div>
      <div class="sub">${escapeHtml(v.subline)}</div>
    </div>
    <div class="footlink"><span class="link">${escapeHtml(v.ctaText)}</span></div>${stripDiv}`;
}

const LAYOUT_MAP = { price_banner: 'A', split_panel: 'B', full_bleed: 'C' };

app.post('/render', async (req, res) => {
  try {
    const {
      layout,          // "price_banner" | "split_panel" | "full_bleed"
      plateUrl,
      eyebrow = '',
      headline,
      subline = '',
      features = [],
      ctaText = '',
      mood = 'day',     // "day" | "night" — needed for Layout C text color
      brand = null,
    } = req.body;

    if (!layout || !LAYOUT_MAP[layout]) {
      return res.status(400).json({ error: `layout must be one of: ${Object.keys(LAYOUT_MAP).join(', ')}` });
    }
    if (!plateUrl || !headline) {
      return res.status(400).json({ error: 'plateUrl and headline are required' });
    }

    let plateBuffer = await fetchBuffer(plateUrl);
    const meta = await sharp(plateBuffer).metadata();

    let stripPx = 0;
    let logoDataUri = '';
    if (brand) {
      const stripFraction = await detectOrCarveStripFraction(plateBuffer);
      stripPx = Math.round(stripFraction * CANVAS);
      plateBuffer = await paintStripWhite(plateBuffer, Math.round(stripFraction * meta.height), meta.width, meta.height);

      const logoBuffer = await fetchBuffer(brand.logoUrl);
      const trimmedLogo = await trimLogo(logoBuffer);
      logoDataUri = 'data:image/png;base64,' + trimmedLogo.toString('base64');
    }

    const plateDataUri = 'data:image/png;base64,' + plateBuffer.toString('base64');
    const stripDiv = stripHtml(brand, logoDataUri);
    const featDiv = LAYOUT_MAP[layout] === 'A' ? featuresHtml(features) : '';
    const featClass = featDiv ? 'has-features' : '';

    const v = { layout: LAYOUT_MAP[layout], eyebrow, headline, subline, ctaText };
    const bodyHtml = body(v, plateDataUri, stripDiv, featDiv);

    const html = TEMPLATE
      .replace('__ANTON__', ANTON)
      .replace('__INTER__', INTER)
      .replace('__STRIPPX__', stripPx + 'px')
      .replace('__LAYOUT__', LAYOUT_MAP[layout])
      .replace('__MOOD__', mood)
      .replace('__FEATCLASS__', featClass)
      .replace('__BODY__', bodyHtml);

    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: CANVAS, height: CANVAS, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.evaluateHandle('document.fonts.ready');
    await page.evaluate(() => Promise.all(
      Array.from(document.images).map(i => (i.complete ? 0 : i.decode().catch(() => {})))
    ));
    const finalSizes = await page.$$eval('.headline', els => els.map(e => e.getAttribute('data-final-size')));
    const canvasEl = await page.$('#canvas');
    const pngBuffer = await canvasEl.screenshot({ type: 'png' });
    await page.close();

    res.set('Content-Type', 'image/png');
    res.set('X-Headline-Fitted-Px', finalSizes.join(','));
    res.send(pngBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render service listening on :${PORT}`));
