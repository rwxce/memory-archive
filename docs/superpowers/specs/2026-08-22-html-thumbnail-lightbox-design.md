# Design: HTML Media Thumbnails + Click-to-Zoom Lightbox

**Date:** 2026-08-22
**Status:** Approved (design)
**Scope:** HTML output only (`src/render/html.ts` + `src/render/js/transcript.js`)
**Goal:** Photos and stickers in the rendered backup appear as thumbnails in the chat bubble; clicking one opens a full-screen lightbox overlay (click anywhere or press ESC to close).

---

## Context & Key Findings

The HTML output is produced two ways, and they interact in a non-obvious way:

1. **Server-rendered HTML (`renderHtml` in `src/render/html.ts`)** builds the transcript as a string and writes `<img>`/`<video>`/`<a>` tags directly into `messages.html`. This is the layer that actually displays when the file is opened **standalone via `file://`**.
2. **Client-rendered transcript (`src/render/js/transcript.js`)** is an ES module loaded by the page. It reads the `#chat-data` JSON island and rebuilds `#transcript` from JSON using DOM APIs. Because it does `import { setText } from './xss-sanitize.js'` (a relative module import), **browsers block it under `file://`** (the project's "open standalone, no server" constraint). So under `file://` the module fails to load and the server-rendered HTML is what the user sees.

Two consequences that shape this design:

- The robust place to add the feature is the **server-rendered HTML**, with a **classic inline `<script>`** (no `type="module"`, no imports) so the lightbox works from `file://`.
- `transcript.js` currently renders **every** media message as a text placeholder (it never emits `<img>`). This is a pre-existing gap: if the page is served over http, media shows as placeholders and the lightbox would be inert. **This design also fixes `transcript.js` to render real images** so the feature works in both `file://` and http modes.

The JSON island carries `mediaPath` per message (`buildEnvelope` -> `toRendered(m, mediaMap?.get(m.media)?.relPath ?? null)` in `src/render/json.ts:60`), so the client path can resolve the image `src`.

---

## Approach

CSS-only thumbnails (no generated thumbnail files, no new dependency) + a classic-inline lightbox overlay. The click handler uses **event delegation on `document`**, so it catches clicks on both server-rendered and client-rendered `.media-img` elements (including ones created dynamically by `transcript.js`).

### 1. `src/render/html.ts` — `mediaHtml`

For `photo` and `sticker` (both relative `media/F` and `--inline` `data:` URIs), emit:

```html
<img class="media-img" src="..." alt="..." loading="lazy">
```

- `src`/`alt` already HTML-escaped (OUT-05). Data URIs are trusted local bytes.
- `video` stays `<video src controls>` (native player; not click-to-zoom).
- `audio`/`document` stay the `<a>` link.
- Missing / not-inlineable -> unchanged `media-placeholder` span.

### 2. `src/render/html.ts` — `CSS`

```css
.media-img { max-width:220px; max-height:280px; border-radius:6px; cursor:zoom-in; display:block; }
.lightbox { position:fixed; inset:0; background:rgba(0,0,0,.88); display:none; align-items:center; justify-content:center; z-index:100; cursor:zoom-out; }
.lightbox.open { display:flex; }
.lightbox img { max-width:95vw; max-height:95vh; border-radius:4px; }
```

(`max-width`/`max-height` preserve aspect ratio — no cropping. Stickers included per requirement.)

### 3. `src/render/html.ts` — template (in `<body>`)

Add once, outside `#transcript` (so it survives the client rebuild):

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

Classic (no `type="module"`), so it executes from `file://`. Reads `src` via `getAttribute` (safe string assignment to `img.src`) — never `innerHTML`.

### 4. `src/render/js/transcript.js` — `bubbleRow` media branch

Replace the always-placeholder branch with real-image rendering when `mediaPath` is present:

```js
} else if (m.media) {
  if (m.mediaPath) {
    const img = document.createElement('img');
    img.className = 'media-img';
    img.src = m.mediaPath;          // 'media/F' or 'data:...'
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

The existing classic inline lightbox script (step 3) handles clicks on these dynamically-created images via `document` delegation. No media-specific JS needed in `transcript.js`.

---

## Behavior / UX

- Thumbnail shown in bubble (max 220x280, aspect preserved).
- Click thumbnail -> dark full-screen overlay with the image fit to viewport; click anywhere on the overlay or press ESC -> closes.
- Stickers included (same `.media-img` treatment).
- Video keeps native controls (click plays, no lightbox).
- Audio/document remain download links.
- Missing media (`mediaPath: null`) -> placeholder, unchanged.

## Constraints Honored

- **No new dependency** — pure HTML/CSS + tiny classic JS.
- **Memory-safe** — CSS-only thumbnails; no thumbnail generation, no extra disk, no buffering.
- **XSS-safe** — all `src`/`alt` escaped at emit; lightbox copies the already-trusted `src` via `getAttribute` (never `innerHTML`); chat text never reaches an attribute unescaped.
- **Standalone (`file://`)** — classic inline script, no module imports.
- **Two render paths coherent** — both server and client output emit `.media-img`; single delegated handler covers both.

## Testing

- **Structural (node, no DOM, matches existing test style in `test/media.test.ts`):** render the Notas sample to HTML; assert every photo/sticker `<img>` carries `class="media-img"`; assert `<div class="lightbox" id="lightbox">` exists once; assert the lightbox `<script>` is present and is **not** `type="module"`; assert `<video controls>` and `media-placeholder` are unchanged.
- **Client-path structural:** assert `transcript.js` renders an `<img class="media-img">` (not placeholder) when `mediaPath` is set, and a `media-placeholder` when `mediaPath` is null (can be checked by reading the source/AST or a jsdom render if available).
- **Manual e2e:** open `output/notas-pessoais/messages.html` via `file://`; confirm images render as thumbnails and clicking opens the lightbox; ESC/backdrop closes it. Re-run with `--inline` to confirm `data:` URI thumbnails + lightbox also work.

## Out of Scope

- Prev/next navigation between images, captions under the lightbox (deferred per user).
- Generating separate thumbnail files (CSS-only chosen).
- Touch/pinch zoom gestures inside the lightbox.
