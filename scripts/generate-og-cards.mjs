// Open Graph share cards: the 1200×630 image chat apps and social networks show
// when someone shares a link to the app, one per UI language.
//
//   pnpm og                    # every locale
//   LOCALES="ca" pnpm og       # a subset
//
// Writes public/og/{locale}.png (committed, like the app icons). The layout is
// drawn in the 1670×941 space of the approved design mock (coordinates below
// are measured on it), widened to the 1.91:1 card and scaled down to 1200×630.
// Rendered by the system Google Chrome through the Playwright that `pnpm e2e`
// already uses: no new dependency, no download, every request blocked (fonts
// and photos are inlined as data: URLs from scripts/og-cards/).
// Font rendering differs between machines, so there is no "stale" test; after
// changing a card, bump OG_VERSION in app/og.ts so caches refetch it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'scripts', 'og-cards');
const OUT = path.join(ROOT, 'public', 'og');
export const WIDTH = 1200;
export const HEIGHT = 630;

// Design space: the mock's height, widened to the card's aspect ratio.
const STAGE_H = 941;
const STAGE_W = Math.round((STAGE_H * WIDTH) / HEIGHT); // 1792
const SCALE = WIDTH / STAGE_W;
// The extra width goes to the margins: text block and picture group move right.
const LEFT_SHIFT = 45;
const RIGHT_SHIFT = 95;

/**
 * Card copy per locale. Kept here, not in messages/*.json, because the app
 * never shows it (the messages are shipped to every page). Follow docs/tone.md.
 */
export const STR = {
  en: {
    head: 'Keep your',
    head2: 'memories',
    accent: 'close',
    sub: 'Conversations, photos and messages from the people who matter most.',
    badges: ['Private', 'No account', 'On your device'],
    name: 'Mom',
    received: 'Have you arrived home?',
    sent: 'Yes, I’m home now',
  },
  ca: {
    head: 'Conserva els teus',
    head2: 'records',
    accent: 'a prop',
    sub: 'Converses, fotos i missatges de les persones que més t’importen.',
    badges: ['Privat', 'Sense compte', 'Al teu dispositiu'],
    name: 'Mama',
    received: 'Ja has arribat a casa?',
    sent: 'Sí, ja soc a casa',
  },
  es: {
    head: 'Conserva tus',
    head2: 'recuerdos',
    accent: 'cerca',
    sub: 'Conversaciones, fotos y mensajes de las personas que más te importan.',
    badges: ['Privado', 'Sin cuenta', 'En tu dispositivo'],
    name: 'Mamá',
    received: '¿Ya has llegado a casa?',
    sent: 'Sí, ya estoy en casa',
  },
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const dataUrl = (file, type) => `data:${type};base64,${fs.readFileSync(path.join(ASSETS, file)).toString('base64')}`;

// The book-with-a-heart mark from app/icon.svg, drawn as a purple book.
const HEART = 'M0 30C-40 5-32-28 0-10C32-28 40 5 0 30Z';
const LOGO = `<svg viewBox="0 0 123 145" width="123" height="145">
  <rect width="123" height="145" rx="26" fill="#faf8ff"/>
  <rect x="21" y="19" width="81" height="107" rx="9" fill="none" stroke="#5027fc" stroke-width="8"/>
  <path d="M38 19V126" stroke="#5027fc" stroke-width="7"/>
  <path transform="translate(70 66)" fill="#5027fc" d="${HEART}"/>
</svg>`;
const CHAT_ICON = `<svg viewBox="0 0 64 68" width="64" height="68">
  <path d="M10 12V58a6 6 0 0 0 6 6h3" fill="none" stroke="#5a2ff5" stroke-width="5" stroke-linecap="round"/>
  <rect x="14" y="4" width="46" height="58" rx="6" fill="#ffffff" stroke="#5a2ff5" stroke-width="5"/>
  <path d="M23 4V62" stroke="#5a2ff5" stroke-width="5"/>
  <path transform="translate(41.5 32) scale(0.56)" fill="#5a2ff5" d="${HEART}"/>
</svg>`;

// lucide icons (the app's icon set), keyhole added to the lock as in the mock.
const ICONS = [
  '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><circle cx="12" cy="15.6" r="1.2" fill="#fff"/><path d="M12 16v2.2"/>',
  '<path d="M10.94 5.274A7 7 0 0 1 15.71 10h1.79a4.5 4.5 0 0 1 4.222 6.057"/><path d="M18.796 18.81A4.5 4.5 0 0 1 17.5 19H9A7 7 0 0 1 5.79 5.78"/><path d="m2 2 20 20"/>',
  '<path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z"/><path d="M20.054 15.987H3.946"/>',
];
const icon = (inner) =>
  `<svg viewBox="0 0 24 24" width="66" height="66" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// Waveform bar heights (px) in the voice-message bubble, left to right.
const WAVE = [14, 30, 20, 38, 24, 16, 34, 26, 40, 22, 30, 18, 34, 24, 16];

/** The card as a self-contained HTML page (fonts and photos inlined). */
export function cardHtml(locale, s) {
  const fonts = `
    @font-face { font-family: Satoshi; font-weight: 900; src: url(${dataUrl('fonts/Satoshi-Black.woff2', 'font/woff2')}) format('woff2'); }
    @font-face { font-family: Satoshi; font-weight: 500; src: url(${dataUrl('fonts/Satoshi-Medium.woff2', 'font/woff2')}) format('woff2'); }
    @font-face { font-family: Satoshi; font-weight: 700; src: url(${dataUrl('fonts/Satoshi-Bold.woff2', 'font/woff2')}) format('woff2'); }`;
  return `<!doctype html>
<html lang="${esc(locale)}"><head><meta charset="utf-8"><style>${fonts}
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #18162b; }
  .stage { position: absolute; left: 0; top: 0; width: ${STAGE_W}px; height: ${STAGE_H}px; overflow: hidden;
    transform: scale(${SCALE}); transform-origin: 0 0; font-family: Satoshi, system-ui, sans-serif; color: #fff;
    -webkit-font-smoothing: antialiased; }
  .abs { position: absolute; }
  .bg { left: 0; top: 0; width: 100%; height: 100%; }
  .left { left: ${LEFT_SHIFT}px; top: 0; width: 1000px; height: 100%; }
  .right { left: ${RIGHT_SHIFT}px; top: 0; width: 1670px; height: 100%; }

  .divider { left: 253px; top: 85px; width: 2px; height: 74px; background: rgba(214, 208, 240, 0.55); }
  .brand { left: 291px; top: 76px; font-size: 64px; font-weight: 900; -webkit-text-stroke: 0.6px #fff; letter-spacing: -0.5px; line-height: 84px; white-space: nowrap; }
  h1 { position: absolute; left: 96px; top: 243px; font-size: 110px; line-height: 105px; font-weight: 900;
    letter-spacing: -2px; white-space: nowrap; text-shadow: 0 4px 24px rgba(10, 6, 30, 0.35); }
  h1 em { font-style: italic; padding-right: 8px; margin-left: -10px;
    background: linear-gradient(90deg, #6c3dff 0%, #8c5cff 55%, #a57dff 100%);
    -webkit-background-clip: text; background-clip: text; color: transparent; }
  .sub { left: 98px; top: 494px; width: 820px;
    font-weight: 500; font-size: 57px; line-height: 53px; letter-spacing: -0.6px; color: #d9d4ec; }
  .badges { left: 98px; top: 683px; height: 60px; display: flex; align-items: center; white-space: nowrap; }
  .badge { display: flex; align-items: center; gap: 16px; font-size: 31px; font-weight: 700; -webkit-text-stroke: 0.7px #fff; letter-spacing: -0.3px; }
  .bsep { width: 2px; height: 52px; margin: 0 32px; background: rgba(170, 160, 210, 0.45); }

  .frame { border-radius: 36px; background: linear-gradient(160deg, #ffffff 0%, #f1eefc 100%);
    box-shadow: 0 30px 60px -18px rgba(8, 4, 30, 0.75), 0 0 0 1px rgba(255, 255, 255, 0.6) inset; }
  .photo { position: absolute; border-radius: 18px; background-size: cover; background-position: center; }
  .chat { border-radius: 46px; background: linear-gradient(170deg, #f8f6ff 0%, #ece8fd 100%);
    box-shadow: 0 40px 80px -20px rgba(8, 4, 30, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.7) inset; color: #16131f; }
  .who { left: 138px; top: 72px; font-size: 37px; font-weight: 700; -webkit-text-stroke: 0.6px #16131f; letter-spacing: -0.3px; }
  .recv { left: 38px; top: 135px; width: 302px; min-height: 107px; padding: 14px 24px; border-radius: 30px;
    background: #e3ddf6; font-size: 28px; line-height: 35px; font-weight: 700; -webkit-text-stroke: 0.5px #16131f; letter-spacing: -0.4px; display: flex; align-items: center; }
  .sent { right: 30px; top: 256px; height: 69px; padding: 0 26px; border-radius: 35px; background: #4a1cfc;
    color: #fff; font-size: 28px; font-weight: 700; -webkit-text-stroke: 0.5px #fff; letter-spacing: -0.4px; display: flex; align-items: center; white-space: nowrap;
    box-shadow: 0 10px 22px -10px rgba(74, 28, 252, 0.7); }
  .audio { left: 31px; top: 347px; width: 235px; height: 78px; border-radius: 39px; background: #dfd9fd;
    display: flex; align-items: center; padding-left: 28px; gap: 4px; }
  .play { width: 0; height: 0; border-left: 22px solid #4316fb; border-top: 13px solid transparent;
    border-bottom: 13px solid transparent; margin-right: 18px; }
  .bar { width: 4px; border-radius: 2px; background: #5a2ff5; }
</style></head><body><div class="stage">

  <svg class="abs bg" viewBox="0 0 1670 941" preserveAspectRatio="none">
    <defs>
      <linearGradient id="base" x1="0" y1="0" x2="1" y2="0.25">
        <stop offset="0" stop-color="#18162b"/><stop offset="0.5" stop-color="#1d1840"/><stop offset="1" stop-color="#271a6c"/>
      </linearGradient>
      <radialGradient id="glowTR" cx="1480" cy="40" r="560" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#6a33f0" stop-opacity="0.85"/><stop offset="1" stop-color="#3a1ea0" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glowB" cx="760" cy="1000" r="620" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#5a28f0" stop-opacity="0.9"/><stop offset="1" stop-color="#2a1880" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glowBR" cx="1670" cy="941" r="520" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#5f2cf5" stop-opacity="0.9"/><stop offset="1" stop-color="#2a1880" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="hill" x1="0" y1="826" x2="0" y2="941" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3b1dae"/><stop offset="1" stop-color="#2a1888"/>
      </linearGradient>
      <linearGradient id="rimB" x1="330" y1="0" x2="1260" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#7d3cfd" stop-opacity="0.6"/><stop offset="0.45" stop-color="#9a55fd"/>
        <stop offset="0.7" stop-color="#f0e4ff"/><stop offset="1" stop-color="#8a45fd" stop-opacity="0.7"/>
      </linearGradient>
      <linearGradient id="rimR" x1="1480" y1="0" x2="1670" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#7d3cfd" stop-opacity="0"/><stop offset="1" stop-color="#dcb6ff"/>
      </linearGradient>
      <linearGradient id="rimT" x1="1120" y1="0" x2="1600" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#b070ff" stop-opacity="0"/><stop offset="0.3" stop-color="#ffffff"/>
        <stop offset="0.65" stop-color="#c08cff"/><stop offset="1" stop-color="#7a3cff" stop-opacity="0.3"/>
      </linearGradient>
      <filter id="blur8" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8"/></filter>
      <filter id="blur3"><feGaussianBlur stdDeviation="2.5"/></filter>
    </defs>
    <rect width="1670" height="941" fill="url(#base)"/>
    <rect width="1670" height="941" fill="url(#glowTR)"/>
    <rect width="1670" height="941" fill="url(#glowB)"/>
    <rect width="1670" height="941" fill="url(#glowBR)"/>
    <!-- bottom hill: circle centre (750,1627) r 801 -->
    <circle cx="750" cy="1627" r="801" fill="url(#hill)"/>
    <circle cx="750" cy="1627" r="801" fill="none" stroke="url(#rimB)" stroke-width="14" filter="url(#blur8)"/>
    <circle cx="750" cy="1627" r="801" fill="none" stroke="url(#rimB)" stroke-width="3"/>
    <!-- right arc: circle centre (1900,1300) r 655 -->
    <circle cx="1900" cy="1300" r="655" fill="#2c1a8a" fill-opacity="0.55"/>
    <circle cx="1900" cy="1300" r="655" fill="none" stroke="url(#rimR)" stroke-width="12" filter="url(#blur8)"/>
    <circle cx="1900" cy="1300" r="655" fill="none" stroke="url(#rimR)" stroke-width="3"/>
    <!-- top-right sweep -->
    <path d="M1120 150 Q1330 112 1580 -20" fill="none" stroke="url(#rimT)" stroke-width="14" filter="url(#blur8)"/>
    <path d="M1120 150 Q1330 112 1580 -20" fill="none" stroke="url(#rimT)" stroke-width="3" filter="url(#blur3)"/>
  </svg>

  <div class="abs left">
    <div class="abs" style="left:88px;top:56px">${LOGO}</div>
    <div class="abs divider"></div>
    <div class="abs brand">Memory Archive</div>
    <h1 id="h1">${esc(s.head)}<br>${esc(s.head2)} <em>${esc(s.accent)}</em></h1>
    <p class="abs sub" id="sub">${esc(s.sub)}</p>
    <div class="abs badges" id="badges">
      ${s.badges
        .map((b, i) => `${i ? '<span class="bsep"></span>' : ''}<span class="badge">${icon(ICONS[i])}${esc(b)}</span>`)
        .join('')}
    </div>
  </div>

  <div class="abs right">
    <svg class="abs" style="left:0;top:0" width="1670" height="941">
      <defs>
        <radialGradient id="sphere" cx="0.62" cy="0.42" r="0.62">
          <stop offset="0" stop-color="#2a1a78"/><stop offset="0.8" stop-color="#211856"/><stop offset="1" stop-color="#32198f"/>
        </radialGradient>
        <linearGradient id="sphereRim" x1="0" y1="0.2" x2="0.6" y2="1">
          <stop offset="0" stop-color="#7b3dff" stop-opacity="0"/><stop offset="0.45" stop-color="#b06cff"/>
          <stop offset="0.75" stop-color="#8a45ff" stop-opacity="0.5"/><stop offset="1" stop-color="#7b3dff" stop-opacity="0"/>
        </linearGradient>
        <filter id="sblur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>
      </defs>
      <circle cx="1240" cy="610" r="318" fill="url(#sphere)"/>
      <circle cx="1240" cy="610" r="318" fill="none" stroke="url(#sphereRim)" stroke-width="12" filter="url(#sblur)"/>
      <circle cx="1240" cy="610" r="318" fill="none" stroke="url(#sphereRim)" stroke-width="3.5"/>
    </svg>

    <div class="abs frame" style="left:1300px;top:197px;width:288px;height:353px;transform-origin:170px 173px;transform:rotate(13.89deg)">
      <div class="photo" style="left:18px;top:19px;width:252px;height:274px;background-image:url(${dataUrl('assets/blossom.png', 'image/png')})"></div>
    </div>
    <div class="abs frame" style="left:942px;top:151px;width:400px;height:420px;transform-origin:168px 229px;transform:rotate(-11.66deg)">
      <div class="photo" style="left:20px;top:21px;width:360px;height:320px;background-image:url(${dataUrl('assets/sunset.png', 'image/png')})"></div>
    </div>
    <div class="abs chat" style="left:1037px;top:350px;width:453px;height:464px;transform-origin:228px 240px;transform:rotate(5.68deg)">
      <div class="abs" style="left:53px;top:52px">${CHAT_ICON}</div>
      <div class="abs who">${esc(s.name)}</div>
      <div class="abs recv" id="recv">${esc(s.received)}</div>
      <div class="abs sent" id="sent">${esc(s.sent)}</div>
      <div class="abs audio"><span class="play"></span>${WAVE.map((h) => `<span class="bar" style="height:${h}px"></span>`).join('')}</div>
    </div>
  </div>
</div></body></html>`;
}

/** Shrinks each text block until it fits its box; fails when it can't. Runs in the page. */
function fitText() {
  const doc = globalThis.document;
  const rightOf = (el) => el.getBoundingClientRect().right;
  const shrink = (el, fits, min) => {
    let size = parseFloat(globalThis.getComputedStyle(el).fontSize);
    while (!fits(el) && size > min) {
      size -= 1;
      el.style.fontSize = `${size}px`;
      el.style.lineHeight = 'normal';
    }
    if (!fits(el)) throw new Error(`#${el.id} does not fit`);
  };
  // Box edges in card pixels (the stage is scaled); measured on the mock.
  const k = doc.querySelector('.stage').getBoundingClientRect().width / 1792;
  const h1 = doc.getElementById('h1');
  shrink(h1, (el) => rightOf(el) <= 945 * k, 70);
  if (h1.style.fontSize) h1.style.lineHeight = `${parseFloat(h1.style.fontSize) * 0.955}px`;
  shrink(doc.getElementById('sub'), (el) => el.scrollHeight <= 2 * 53 + 6, 36);
  shrink(doc.getElementById('badges'), (el) => rightOf(el) <= 1080 * k, 22);
  shrink(doc.getElementById('recv'), (el) => el.scrollHeight <= 107 && el.scrollWidth <= el.clientWidth, 20);
  shrink(doc.getElementById('sent'), (el) => el.scrollWidth <= 400, 20);
}

async function main() {
  const all = Object.keys(STR);
  const locales = (process.env.LOCALES ?? all.join(' ')).split(/\s+/).filter(Boolean);
  for (const l of locales) if (!STR[l]) throw new Error(`no card copy for "${l}" (have ${all.join(', ')})`);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    // The card is self-contained; refuse any request so nothing remote can sneak in.
    await page.route('**/*', (route) => route.abort());
    for (const locale of locales) {
      await page.setContent(cardHtml(locale, STR[locale]));
      await page.evaluate(() => globalThis.document.fonts.ready);
      await page.evaluate(fitText).catch((err) => {
        throw new Error(`og card for ${locale}: ${err.message}; shorten the copy`);
      });
      const file = path.join(OUT, `${locale}.png`);
      await page.screenshot({ path: file, type: 'png' });
      console.log(`${String(Math.round(fs.statSync(file).size / 1024)).padStart(5)} KB  ${path.relative(ROOT, file)}`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
