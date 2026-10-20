# HTML Media Thumbnails + Click-to-Zoom Lightbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render photos and stickers in the backup HTML as thumbnails; clicking one opens a full-screen lightbox overlay (click anywhere or ESC to close).

**Architecture:** CSS-only thumbnails (no thumbnail files generated) plus a classic inline `<script>` lightbox that works from `file://` (the project's no-server constraint). Both the server-rendered HTML (`src/render/html.ts`) and the client-rendered transcript (`src/render/js/transcript.js`) emit `.media-img`; a single document-level delegated click handler covers both.

**Tech Stack:** TypeScript / Node ESM; plain HTML + CSS + classic (non-module) JavaScript. No new dependencies.

## Global Constraints

- **No new dependency** — pure HTML/CSS + tiny classic JS.
- **Memory-safe** — CSS-only thumbnails; no thumbnail generation, no extra disk, no buffering.
- **XSS-safe** — all `src`/`alt` escaped at emit (OUT-05); lightbox copies the already-trusted `src` via `getAttribute` (never `innerHTML`); chat text never reaches an attribute unescaped.
- **Standalone (`file://`)** — classic inline script, no module imports (ES module imports are blocked under `file://`).
- **Two render paths coherent** — both server and client output emit `.media-img`; single delegated handler covers both.
- Project-wide: source of truth is the CSV; renderers re-read `messages.csv`; output must open standalone in any browser with no server.

---

## File Structure

- **Modify `src/render/html.ts`** — (a) `mediaHtml` adds `class="media-img"` to photo/sticker `<img>` in both the non-inline and inline (`--inline`) branches; (b) the `CSS` string gains `.media-img` + `.lightbox` rules; (c) the HTML template gains a `<div class="lightbox" id="lightbox">` plus a classic inline `<script>` (event-delegated click/ESC handler).
- **Modify `src/render/js/transcript.js`** — `bubbleRow`'s media branch renders a real `<img class="media-img">` when `m.mediaPath` is present, else the existing placeholder. No media-specific JS needed here (the lightbox handler lives in the server HTML).
- **Create `test/html-media.test.ts`** — structural assertions on the rendered `messages.html` (no DOM needed) plus a source-content assertion for `transcript.js`.

---

### Task 1: Server-rendered thumbnails (`.media-img` class + CSS)

**Files:**
- Modify: `src/render/html.ts:35-78` (`mediaHtml` + `readFileAsDataUri`)
- Modify: `src/render/html.ts:212-236` (`CSS`)
- Test: `test/html-media.test.ts` (create)

**Interfaces:**
- Consumes: `mediaHtml(m, media, inline, dir)` already returns `<img>` for photo/sticker; we only add a class.
- Produces: every photo/sticker `<img>` in the output HTML carries `class="media-img"`; CSS defines thumbnail sizing.

- [ ] **Step 1: Write the failing test** (create `test/html-media.test.ts`)

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { runParser } from '../src/model';
import { slugifyChatName } from '../src/extract';

const ROOT = process.cwd();
const NOTAS = 'WhatsApp Chat - Notas pessoais';

test('html: photo/sticker imgs get media-img class + thumbnail css', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-html-'));
  await runParser(path.join(ROOT, 'data', `${NOTAS}.zip`), { out });
  const dir = path.join(out, slugifyChatName(NOTAS));
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');

  const imgTags = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
  const mediaImgs = imgTags.filter((t) => t.includes('class="media-img"'));
  assert.ok(mediaImgs.length > 0, 'expected at least one .media-img');

  for (const t of imgTags) {
    if (t.includes('class="media-img"')) continue;
    assert.ok(t.trim() === '<img alt="">', `unexpected <img>: ${t}`);
  }

  assert.ok(html.includes('.media-img'), 'css .media-img rule present');
  assert.ok(/max-width:\s*220px/.test(html), 'thumbnail max-width present');
  assert.ok(/max-height:\s*280px/.test(html), 'thumbnail max-height present');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/html-media.test.ts`
Expected: FAIL (no `.media-img` img; no `.media-img` css rule).

- [ ] **Step 3: Write minimal implementation**

In `src/render/html.ts`, update the two photo/sticker `<img>` emissions to include `class="media-img"`:

In `mediaHtml` (non-inline branch):
```ts
      return `<img class="media-img" src="${rel}" alt="${alt}" loading="lazy">`;
```
In `readFileAsDataUri` (inline branch):
```ts
    return `<img class="media-img" src="${dataUri}" alt="${alt}" loading="lazy">`;
```

Append to the `CSS` string (inside the template literal, before the closing backtick):
```css
.media-img { max-width:220px; max-height:280px; border-radius:6px; cursor:zoom-in; display:block; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/html-media.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/render/html.ts test/html-media.test.ts
git commit -m "feat(html): thumbnails via .media-img class + css sizing"
```

---

### Task 2: Lightbox container + classic inline script

**Files:**
- Modify: `src/render/html.ts:262-288` (HTML template inside `renderHtml`)
- Test: `test/html-media.test.ts` (append one test)

**Interfaces:**
- Consumes: `.media-img` imgs from Task 1.
- Produces: a `<div class="lightbox" id="lightbox">` present once in the document, plus a classic (non-module) `<script>` that opens it on `.media-img` click and closes on backdrop click / ESC.

- [ ] **Step 1: Write the failing test** (append to `test/html-media.test.ts`)

```ts
test('html: lightbox container + classic (non-module) script present', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-html-lb-'));
  await runParser(path.join(ROOT, 'data', `${NOTAS}.zip`), { out });
  const dir = path.join(out, slugifyChatName(NOTAS));
  const html = fs.readFileSync(path.join(dir, 'messages.html'), 'utf8');

  assert.ok(html.includes('<div class="lightbox" id="lightbox">'), 'lightbox container present');

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const lb = scripts.find(
    (s) => s[2].includes("getElementById('lightbox')") && s[2].includes("classList.add('open')"),
  );
  assert.ok(lb, 'lightbox handler script found');
  assert.ok(!/type="module"/.test(lb[1]), 'lightbox script is NOT a module');
  assert.ok(html.includes('.lightbox {'), 'css .lightbox rule present');
  assert.ok(html.includes('.lightbox.open'), 'css .lightbox.open rule present');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/html-media.test.ts`
Expected: FAIL (no `#lightbox` div; no matching script).

- [ ] **Step 3: Write minimal implementation**

Add the lightbox CSS to the `CSS` string:
```css
.lightbox { position:fixed; inset:0; background:rgba(0,0,0,.88); display:none; align-items:center; justify-content:center; z-index:100; cursor:zoom-out; }
.lightbox.open { display:flex; }
.lightbox img { max-width:95vw; max-height:95vh; border-radius:4px; }
```

In the HTML template, add just before `</body>` (outside `#transcript`, so it survives the client rebuild):
```html
<div class="lightbox" id="lightbox"><img alt=""></div>
<script>
  (function(){
    var lb = document.getElementById('lightbox');
    var img = lb && lb.querySelector('img');
    document.addEventListener('click', function(e){
      var t = e.target;
      if (t && t.classList && t.classList.contains('media-img') && img) {
        img.src = t.getAttribute('src'); img.alt = t.getAttribute('alt') || '';
        lb.classList.add('open'); e.preventDefault();
      } else if (lb && lb.classList.contains('open')) {
        lb.classList.remove('open');
      }
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && lb) lb.classList.remove('open');
    });
  })();
</script>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/html-media.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/render/html.ts test/html-media.test.ts
git commit -m "feat(html): lightbox overlay with classic inline handler"
```

---

### Task 3: Client transcript renders real images (`transcript.js`)

**Files:**
- Modify: `src/render/js/transcript.js:84-88` (`bubbleRow` media branch)
- Test: `test/html-media.test.ts` (append one source-content test)

**Interfaces:**
- Consumes: message object `m` with `m.media` (filename) and `m.mediaPath` (`media/F` or `data:` URI, or `null` when missing).
- Produces: real `<img class="media-img">` when `m.mediaPath` is set; `media-placeholder` span otherwise. The lightbox handler from Task 2 (delegated on `document`) already covers clicks on these dynamically-created imgs.

> Note: `transcript.js` is an ES module blocked under `file://`; this task makes the http-served path coherent with the server HTML. Automated coverage here is a source-content assertion (no jsdom dependency); behavior is also confirmed by the manual e2e in Task 4.

- [ ] **Step 1: Write the failing test** (append to `test/html-media.test.ts`)

```ts
test('transcript.js: renders real img when mediaPath present, placeholder otherwise', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/render/js/transcript.js'), 'utf8');
  assert.ok(src.includes("img.className = 'media-img'"), 'renders .media-img img');
  assert.ok(src.includes('img.src = m.mediaPath'), 'uses m.mediaPath for src');
  assert.ok(src.includes('media-placeholder'), 'still falls back to placeholder');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test test/html-media.test.ts`
Expected: FAIL (current `transcript.js` only emits `media-placeholder` for media).

- [ ] **Step 3: Write minimal implementation**

In `src/render/js/transcript.js`, replace the `else if (m.media)` block:
```js
  } else if (m.media) {
    if (m.mediaPath) {
      const img = document.createElement('img');
      img.className = 'media-img';
      img.src = m.mediaPath;
      img.alt = m.media;
      img.loading = 'lazy';
      line.appendChild(img);
    } else {
      const ph = document.createElement('span');
      ph.className = 'media-placeholder';
      setText(ph, mediaLabel(m));
      line.appendChild(ph);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test test/html-media.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/render/js/transcript.js test/html-media.test.ts
git commit -m "fix(html): transcript.js renders real images, not placeholders"
```

---

### Task 4: Full-suite + manual end-to-end verification

**Files:**
- Test: run existing suite (regression)

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Run the entire test suite (regression gate)**

Run: `node --import tsx --test "test/*.test.ts"`
Expected: all pass (prior suites + the 3 new `test/html-media.test.ts` tests).

- [ ] **Step 2: Manual e2e — default (file://) mode**

```bash
rm -rf output/notas-pessoais
node --import tsx src/index.ts "data/WhatsApp Chat - Notas pessoais.zip"
```

Open `output/notas-pessoais/messages.html` in a browser via `file://`. Confirm:
- Photos and stickers appear as thumbnails in their bubbles.
- Clicking a thumbnail opens a full-screen dark overlay with the image; clicking anywhere or pressing ESC closes it.
- Video messages still show the native player (no lightbox); audio/document still show links.

- [ ] **Step 3: Manual e2e — inline mode**

```bash
rm -rf output/notas-pessoais
node --import tsx src/index.ts "data/WhatsApp Chat - Notas pessoais.zip" --inline
```

Open the HTML and confirm thumbnails + lightbox also work with `data:` URI sources (no `media/` folder needed).

- [ ] **Step 4: Commit verification note only if files changed**

Do not commit unless you edited files in Steps 2–3 (you should not have). If Step 1 is green and manual Steps 2–3 pass, the plan is complete.

---

## Completion Criteria

- [ ] `test/html-media.test.ts` exists with 3 passing tests (thumbnail class+CSS, lightbox container+classic script, transcript.js source assertion).
- [ ] Full suite (`node --import tsx --test "test/*.test.ts"`) is green.
- [ ] Manual `file://` e2e: thumbnails visible; click-to-zoom open/close works; video/audio/document unchanged.
- [ ] Manual `--inline` e2e: thumbnails + lightbox work with `data:` URIs.
- [ ] No new dependency introduced; XSS-safe; memory-safe; standalone `file://` compatible.

## Commit Message Convention

Each task commits on main (no branch, per `branching_strategy: none`). Conventional prefixes:
- `feat(html):` for new user-facing behavior (Tasks 1, 2)
- `fix(html):` for the transcript.js correctness fix (Task 3)
- No commit for Task 4 unless docs change.
