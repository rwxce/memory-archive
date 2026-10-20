# Phase 2: Multi-Format Rendering — Discussion Log

**Date:** 2026-08-21
**Participants:** User (visionary), agent (builder)
**Mode:** default (interactive)

## Areas Discussed

### 1. HTML appearance
| Question | Options presented | Decision |
|---|---|---|
| Theme | Light only / Dark only / Both + toggle | **Both + toggle** (localStorage persisted) |
| Bubble colors | WhatsApp authentic / Per-sender hues / Hybrid | **Hybrid** — green/white bubbles + per-sender accent on names |
| Fonts | System stack / Embedded webfont | **System stack** |
| Page layout | Centered column ~768px / Full width | **Centered column** |
| Media rendering (this phase) | Placeholder boxes / Filename text | **Placeholder boxes** |
| Day dividers | WhatsApp-style pill / Minimal rule | **WhatsApp-style pill**, pt-BR Intl |
| System messages | Centered pill / Italic bubble | **Centered gray pill** |
| Print + hover timestamps | Both / Print only / Neither | **Both** |
| Message grouping | Cluster same-sender ~5min / Solo bubbles | **Cluster** |
| Avatars | None / Initials chips | **Initials chips** |

### 2. JSON shape
| Question | Options presented | Decision |
|---|---|---|
| Top-level structure | Envelope + messages array / Flat array | **Envelope** |
| Field naming | camelCase / snake_case (=CSV) | **camelCase** |
| Precomputed day/time fields | Yes / Timestamp only | **Yes** |

### 3. Markdown style
| Question | Options presented | Decision |
|---|---|---|
| Structure | Day sections `##` / Flat chronological | **Day sections** |
| Media | Image embed / Labeled link | **Labeled link** `[📷 photo: FILENAME]` |
| System/deleted/omitted | Italic line / Blockquote | **Italic line** |

### 4. File layout & CLI
| Question | Options presented | Decision |
|---|---|---|
| File placement | Same folder as CSV / Per-format dirs | **Same folder** `messages.{csv,json,md,html}` |
| Format selection | Always all 4 / All + `--formats` | **Always all 4** |

### 5. HTML templating & architecture
| Question | Options presented | Decision |
|---|---|---|
| Template engine | eta / @kitajs/html / Hand-rolled | **eta 4.6** |
| CSS delivery | Inline `<style>` / Sidecar .css | **Inline `<style>`** |
| Template organization | Partials / Single file | **Partials in src/render/templates/** |
| Toggle JS | Inline vanilla / Sidecar .js | **Inline vanilla (~10 lines)** |
| XSS proof | Adversarial fixture / Trust engine | **Adversarial fixture test** |
| Huge chats | Single file / Paginated | **Single file** |

### 6. JSON as message repository (user-initiated pivot)
User proposal: "The HTML can have a JavaScript function that reads the JSON as a message repository and populates the tags dynamically, for browsing and filtering."
| Question | Options presented | Decision |
|---|---|---|
| JSON delivery to viewer | Inline data island / External fetch | **Inline `<script type="application/json">` island** (fetch fails on file://) |
| Filter capabilities | Full toolkit / Search+sender / Search only | **Text search + sender dropdown** |
| Client render method | DOM APIs / innerHTML | **DOM APIs (textContent)** — injection-proof |
| eta's remaining role | Shell rendering / Drop eta | **eta renders the shell; bubbles are JS-built** |
| JSON formatting | Pretty / Minified | **Minified** |

### 7. Verbose reporting
| Question | Options presented | Decision |
|---|---|---|
| Verbose content | Files+sizes+stats / Minimal | **Files + stats** (off by default, D-07 consistent) |

### 8. Renderer input
| Question | Options presented | Decision |
|---|---|---|
| Renderer input | CSV from disk / In-memory parse result | **CSV from disk each run** (true to D-13) |

## Deferred Ideas
- Date-range pickers and type filters (media-only/deleted-only views) in the HTML viewer.
- Per-sender stats section in the JSON envelope.

## Agent's Discretion
- Exact CSS values, accent-hue hash algorithm, search UX details, envelope key naming beyond specified fields, internal module split of `src/render/`.
