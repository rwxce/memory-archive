# Memory Archive blueprint

What this repo **has** — architecture, test types, tools, agents, rules — with the technical
name of each piece and the path where it lives. It is an inventory, not a manual: follow the
path when you need the detail. Items marked **(planned)** are approved in
[`roadmap.md`](roadmap.md) but not built yet.

Keeping it current: adding or removing an agent, skill, hook, custom lint rule, CI workflow,
test type or architecture rule means updating this file **in the same PR**.

## 1. Stack

- **App (`app/`, `components/`, `hooks/`, `i18n/`, `messages/`):** Next.js 16 App Router,
  `output: 'export'` (static files in `out/`, no server, no middleware), `trailingSlash: true`,
  images unoptimized, `basePath` from `NEXT_PUBLIC_BASE_PATH` (e.g. `/memory-archive` for
  GitHub Pages) — `next.config.ts`. React 19.
  - `next-intl` — locales `en` (default), `ca`, `es`; every page is prerendered under
    `/<locale>/` (`generateStaticParams`, `localePrefix: 'always'`); `/` picks the locale in
    the browser from `navigator.languages` (`components/locale-redirect.tsx`,
    `pickLocale` in `i18n/routing.ts`) with plain links as a no-JS fallback.
  - Tailwind CSS 4 (`@tailwindcss/postcss`, `app/globals.css`, warm palette, system font
    stacks) + shadcn/ui new-york (`components.json`; only `components/ui/{button,card}.tsx`
    with `@radix-ui/react-slot`, `class-variance-authority`, `clsx`, `tailwind-merge`,
    `tw-animate-css`), `lucide-react` icons.
  - Theme: `.dark` class on `<html>` set before first paint by `THEME_INIT_SCRIPT`
    (`hooks/theme.ts`; device preference or the choice in `localStorage`), `useTheme`,
    `ThemeSync` (re-applies after a client-side locale switch).
  - Library connection: `hooks/use-library.tsx` (`LibraryProvider` in the locale layout,
    `useLibrary`) opens the db worker (`${NEXT_PUBLIC_BASE_PATH}/db/worker.js`) and the blob
    store lazily, when the first screen that needs them mounts (Settings never holds the
    library; only one tab can). Each attempt has a generation number: the provider closes the
    library on unmount, and an open that finishes after an unmount or a retry is closed and
    ignored (StrictMode mount → cleanup → mount leaves one live library). The library is also
    closed on `pagehide` (and reopened on a back/forward-cache restore), so a full page
    navigation or locale switch hands it over early; "in use" is retried automatically with a
    250 ms → 4 s backoff (about 8 s) while the screen shows loading, and each open is raced
    against a 10 s timeout (`lib/usecases/library.ts`: `OPEN_BACKOFF_MS`, `openWithTimeout`), so
    Try again never waits behind a hung worker. States: loading / ready / unavailable (open in another tab or no
    private storage; retry) / newer version / error. `hooks/use-people.ts` (`usePeople`,
    `useProfileActions`) — an action resolves only after the lists on screen have reloaded, so the
    form closes onto the new list (no stale or empty-state flash). `hooks/use-person-details.ts`
    (`usePersonDetails(id)`: loading / ready / not-found / error) and
    `hooks/use-conversation-actions.ts` (rename / move / link / unlink; same reload contract).
    No dynamic route segments for ids (static export): detail screens use query params
    (`/person?id=`).
  - **Person timeline** (`/[locale]/person/timeline/?id=<uuid>[&date=YYYY-MM-DD]`,
    `components/person-timeline-screen.tsx`, `hooks/use-person-timeline.ts`, first in
    `person-sections.tsx`): the person's whole history as one virtualized feed across all their
    conversations, in the conversation view's own components. `ConversationBody` takes a `FeedSource`
    (`id`, `count`, `readWindow`, `findOffset`, `listDays`, `start`, optional `timeline`) instead of a
    conversation, so `useMessagePages` and `useConversationDays` read through functions and the
    conversation screen builds its source from the same use cases. On a timeline a row from another
    conversation than the one before gets a link chip with the title (`MessageRow` `conversationTitle` /
    `conversationHref` -> `/conversation?id=&from=&date=`), and each row uses its own `conversationId`
    (message details). `isMe` is decided per message by its conversation's "me" author, so outgoing
    stays on the right everywhere; sender colour is a hash of the author name, so one name keeps one
    colour across conversations. The reading position is saved under `timeline:<personId>`.
  - **Person gallery** (`/[locale]/person/gallery/?id=<uuid>`, `components/person-gallery-screen.tsx` /
    `person-gallery-tile.tsx`, listed after Timeline in `person-sections.tsx`): every photo and video (stickers
    excluded) of the person's conversations, oldest first, as a square-tile grid (3 columns at 375 px up to
    6 at 1440) under month headings (`components/group-by-month.ts`, shared with Audio), from
    `usePersonMedia(['photo','video'])`: 50 tiles then "Show more", a plain paged grid, not virtualized
    (tiles are cheap and fixed-size; only photos near the screen hold a file). Each tile is one link, named
    "Open in conversation ...: type, date", to `/conversation?id=&from=&date=`. A photo is read only while
    its tile is within 600 px of the viewport (`hooks/use-near-viewport.ts`, IntersectionObserver) through
    `hooks/use-tile-image.ts` (the one seam: a cached 320 px thumbnail, made on first need, or the
    full-size file when none can be made), the shared 3-at-a-time queue, and its URL is revoked when the tile leaves that window or unmounts. A video tile is
    a play glyph and its file name and reads nothing. Missing and undecodable files are a calm note in the
    tile. A tile is a button that opens the item full size in `components/person-gallery-lightbox.tsx`, a
    native modal `<dialog>` (focus trapped and returned by the browser, Escape closes, focus then goes back
    to the tile): photo fitted and never enlarged, video with its own controls (stopped and released when
    left), title / kind / date / author / caption as text, Previous / Next buttons and ArrowLeft / ArrowRight
    over the loaded items (Next at the last loaded one asks `usePersonMedia` for the next page and moves on
    when it arrives; on failure it stays put), "n of loaded" in a polite live region and an "Open in
    conversation" link (`components/person-gallery-href.ts`, shared with the tile). The full-size file comes
    from `hooks/use-lightbox-media.ts`: only the open item and, when idle, the next photo hold an object
    URL; the rest are revoked as it moves on and all on close. No swipe.
  - **Person audio** (`/[locale]/person/audio/?id=<uuid>`, `components/person-audio-screen.tsx` /
    `person-audio-item.tsx`, reached from `components/person-sections.tsx`, the section links shared by the
    person page and each section page; only sections that exist are listed): every voice message and audio
    file of the conversations kept under the person, oldest first, under month headings, from
    `hooks/use-person-media.ts` (generic over `kinds`, so the photo/video gallery reuses it; the first 50 rows
    and the total, then "Show more" 50 at a time; a plain paged list, not virtualized: a person's audio is
    read on demand and the DOM only grows as far as the person asks). A file is read only when its *Play* is
    pressed (`useMediaUrl` + the shared media queue, object URL revoked on cleanup); only one item holds a
    player at a time, so starting another stops the first. Each item links to `/conversation?id=&from=&date=`.
    Loading, empty, error with retry, and not-found states.
  - **Favorites** (`/[locale]/person/favorites/?id=<uuid>`, `components/person-favorites-screen.tsx` /
    `person-favorite-item.tsx`, section link in `person-sections.tsx`): the starred messages of every
    conversation kept under the person, oldest first, by month, from `hooks/use-person-favorites.ts`
    (`listFavorites({ profileId })`, 50 and "Show more", later pages read from the number shown so a
    removal never skips one). Each card shows when, who, the conversation, the text (or the media kind and
    file name; no file is read here) and "Open in conversation". Its star removes the favorite once it is
    stored; the card leaves the list with a calm live-region note and no undo (the message stays, one
    press re-stars it). The star on a message row (`components/favorite-button.tsx`, beside Details, not on
    system / deleted / omitted notices) is optimistic: `hooks/use-favorite-toggle.ts` patches the paged
    cache in place (`useMessagePages().setFavorite`, remembered per message so a page read later or
    in flight shows it; no refetch, no height change), rolls back and announces on failure, and ignores
    taps while that message's write runs. Stars in the gallery / lightbox are a follow-up.
  - **Notes** (one editable text per person, conversation or message; `components/note-editor.tsx` over
    `hooks/use-note.ts`, which reads the note lazily, saves through `setNote` and reports the change even if
    the caller has unmounted). The editor is a labelled textarea (`maxLength` = `NOTE_MAX`, remaining-characters
    counter only within 500 of it, `dir="auto"`, line breaks kept, never markup), Save (Ctrl/Cmd+Enter too),
    Close/Cancel, Delete; Delete and "save an empty text" ask first, Close/Cancel with unsaved text asks
    first, a failed write keeps the text and offers another try, `invalid` is explained under the field, and
    "Saved {relative} · {absolute}" comes from `formatWhen`. Where it appears: a Notes panel on the person's
    page and a note button under the title of a conversation (`components/note-panels.tsx`); the note button
    on a message row (`components/note-button.tsx`, beside the star and Details, not on notices) opens the
    editor under the bubble (the row grows like Details) and patches `hasNote` in the paged cache
    (`useMessagePages().setNote`, remembered per message like the star); unsaved text lives in a map kept by
    the feed, so a row scrolled out of the window and back reopens its editor with the draft. **Notes list**
    (`/[locale]/person/notes/?id=<uuid>`, `components/person-notes-screen.tsx` / `person-note-item.tsx`,
    `hooks/use-person-notes.ts`, fifth entry of `person-sections.tsx`): `listNotes({ profileId })`, 50 and
    "Show more", each card with its kind, text, last edit, the quoted message and conversation title for a
    message note, "Open in conversation" / person / conversation, and the same editor in place (a saved note
    updates the card, a deleted one leaves the list with a live-region note). Undoing an import that created a
    conversation now says that its notes and favorites are removed with it (wizard and import history).
    **Search** (`/[locale]/search/[?person=<uuid>|?conversation=<uuid>][&q=]`, `components/search-screen.tsx` /
    `search-result-item.tsx` / `search-highlight.tsx` / `search-index-progress.tsx`, hooks `use-search.ts` (input
    debounce 250 ms, minimum 2 letters, only the latest request counts, 50 per page read from the number shown),
    `use-search-index.ts` (status then `buildSearchIndex` with progress and Cancel, aborted on unmount; "Preparing
    search" for a never-built index, "Search is being refreshed" for a stale one, `unavailable` is its own calm state)
    and `use-search-scope.ts` (person name or conversation title; both scopes or a bad id is a calm not-found)):
    matches are `<mark>` built from the snippet ranges (invalid ranges are skipped), text only, never
    `dangerouslySetInnerHTML`; each result links to its conversation at that day (with `from=` when scoped to a
    person); the address follows the query with `history.replaceState`. Entry points: Search button on People,
    sixth entry of `person-sections.tsx` (scoped to the person), and a link in the conversation header.
  - **Conversation** (`/[locale]/conversation/?id=<uuid>[&from=<person>][&date=YYYY-MM-DD]`,
    `components/conversation-screen.tsx` / `conversation-body.tsx` / `message-row.tsx` /
    `message-media.tsx`, opened from the conversation lists with an *Open* link): a virtualized
    feed (`hooks/use-virtual-list.ts` over `hooks/height-index.ts`, about 300 rows in the DOM)
    fed by windowed reads (`hooks/use-message-pages.ts`, pages of the cache by offset, at most
    12 kept), so a 200k-message chat never loads whole. `hooks/use-conversation.ts` opens the
    view and resolves where to start: the end, a valid `?date=` (a calendar-invalid one is
    ignored), or the position saved for the tab (`hooks/conversation-position.ts`,
    `sessionStorage`, index and offset only). The date picker jumps (the latest pick wins) and
    announces it. The *Calendar* button
    opens a panel (`components/conversation-calendar.tsx`, `calendar-day-grid.tsx`): years, the
    months of a year, then a Monday-first grid of days where only days with messages can be
    chosen (arrow keys, Home/End, Escape; one tab stop). It reads `listConversationDays` lazily on
    first open (`hooks/use-conversation-days.ts`: loading / error / Retry, kept while the screen
    lives) and aggregates with pure string helpers (`hooks/calendar-days.ts`, no timezone).
    Choosing a day uses the same jump as the date picker and closes the panel. Media: `hooks/use-media-url.ts` makes object URLs through a small queue
    (`hooks/media-queue.ts`, 3 reads at once, cancelled on unmount, revoked on cleanup); photos,
    stickers and voice notes load as rows come into view, video and documents only on tap.
    Message text is rendered as React text; `splitLinks` (`lib/usecases/message-text.ts`) only
    turns http(s) URLs into links. A view that stays open does not re-read after an import
    in another tab: reopen to refresh. Each message has a small *Message details* button beside
    the bubble (`components/message-details.tsx`; 44 px, shown on hover/focus with a mouse and always
    on touch, `aria-expanded` / `aria-controls`; none on notices) that opens a block under it with
    the source (`whatsapp` is named through i18n, anything else is shown as plain text) and the
    import date. `hooks/use-message-source.ts` reads `getMessageSource` lazily on first open and
    keeps the result (loading / error with Retry / not-found said calmly). The block lives inside
    the row, so the list's existing row measuring absorbs the height change; open state is per row
    and is lost when the row scrolls out of the window. Tests: `conversation-screen.test.tsx`
    (toggle, states, ca), `hooks/use-message-source.test.tsx`, and an e2e flow in
    `e2e/conversation.spec.ts` (keyboard, no jump).
  - **Import history** (`/[locale]/import/history/`, optional `?person=<id>`,
    `components/import-history-screen.tsx`, `hooks/use-import-history.ts`): newest-first list of imports
    (file name, relative + absolute date, messages added / already there, conversation title, the
    people it is kept under as links or "not assigned yet", "created the conversation", messages that still
    carry media), pages of 20 with "Show older imports" (`historyCursorOf`; a reload after an undo re-reads as many entries as were shown, page by page, never asking for more than the server cap of 200; a page dropped because the list changed meanwhile is not an error; an empty last page moves focus to the heading),
    calm empty state with a link to the wizard, code-based error copy. "Undo this import" asks first
    (what goes, what stays: other imports are untouched; the conversation goes only if this import created it and
    nothing else is left), handles `busy` calmly, announces in the live region and focuses the heading; an import with
    no messages left, or that added none, has no undo and says why. The Undo buttons' accessible name starts with the visible words ("Undo this import: {title}", also in the wizard). Linked from the wizard (start and finish), People, the person page and Settings.
  - **Import wizard** (`/[locale]/import/`, `components/import-screen.tsx` and its parts
    `import-choose` / `import-wizard` / `import-steps` / `import-run` / `import-types`,
    `hooks/use-import.tsx`): files picked, dropped or shared (the share inbox is offered in the
    same list; only ZIPs, others are counted and left out), then five steps per file with
    focus on the step heading (preview, person, "me", what is new, space and confirm), then a
    sequential run with progress, cancel and per-file results with undo. Reached from People
    ("Import a chat"). Rules: every choice is explicit (the `suggestedMe` guess is pre-selected and
    says so; a missing choice is explained under the question, Next never picks); a file's
    state is kept while going back; step 1 previews with `conversation:{mode:'new'}` (no library
    lookup) and step 4 re-previews with the person, date reading and conversation chosen, keyed by
    those choices so an older answer is ignored; dates that read both ways and ambiguous matches are
    questions the person answers (`dayFirst`/`monthFirst`, `existing`/`new`); an unknown quota
    never blocks and "Import without videos" appears when there are videos; the person created in
    step 2 exists at once (an empty person is normal), everything else is written only after the
    last confirmation; all files are confirmed first and then imported one after the other (a
    preview is refused while an import runs, so previews of later files describe the library
    before the earlier ones are added; the import decides again under the lock, and an
    `ambiguous` answer then sends that file back to step 4); a cancel stops the queue (rest
    "not started"), a cancel after the save began completes the import and says so; failures show
    code-based copy (`importProblemOf` in `lib/usecases/import-wizard.ts`), never the error message;
    the wizard's pure rules (requests, problems, ZIP test) live in that use-case module; a preview
    refused as `busy` (the open-time cleanup holds the guard) is retried for ~3 s in `use-import`.
    `beforeunload` warns while a run is going. The share inbox copy of a file is deleted after its
    successful import (`discardSharedFile`); a shared file that is not a ZIP (a TXT) is discarded
    when the screen first sees it, since nothing can import it yet. "Add a new person" does not
    clear the earlier choice (`FileItem.addingPerson`; Next is blocked while the form is open, Cancel and
    Back restore the radio); a created person's radio takes the focus. The chosen person's name is kept in
    the file's state, so the result screen never depends on the people list loading. Step 4's
    answer sits in one persistent `aria-live="polite"` region whose content swaps. `import.problem`
    wording never promises an unchanged archive after the import began (`workerFailed`, `storage`,
    `other` say that trying again creates no duplicates); a crash while only reading says nothing changed (`readFailed`).
  - Pages: `/[locale]/` home (People once the library holds any profile, the welcome while it
    is empty — the switch runs on the device; if the library cannot open on first run it still shows
    the welcome with the reason and a retry beneath it, never only an error; while loading it
    shows a neutral shell with the welcome's spacing), `/[locale]/people/` (People: active list with
    relationship and conversation count, collapsed Archived section, inline create / edit form,
    archive with a confirmation that says what is kept (Escape closes it and the form), restore;
    one polite status region stays mounted in every state; busy buttons use `aria-disabled` (they keep focus); Escape is ignored during IME composition; person names are h2 under the page h1; initials avatar, no photo
    upload yet; a name links to the person page; a "Not assigned to anyone yet" section appears only
    while some conversation belongs to no one, with Rename and *Assign to…*), `/[locale]/person/?id=`
    (Person: name, relationship, notes, archived badge, the same Edit / Archive / Restore as the
    list (`person-actions.tsx`), and the person's conversations (`conversation-list.tsx`: title,
    *Group chat* badge, message count, first–last day, participants, "also kept under"). Per
    conversation: inline rename (same validation as profiles), *Move to another person*, and for
    group / shared chats *Also keep under…* and *Unlink* (confirmation; unlinking the last person
    leaves it unassigned). Targets are active people, archived ones in their own labelled group;
    every panel says messages and photos are not copied or changed. Failures are explained once, by the panel's own alert (the unlink confirmation carries its own; cleared on cancel); with nobody to choose, focus goes to Cancel. Move / Also keep under… / Assign to… aria-labels start with the visible text (WCAG 2.5.3); long unbroken names wrap (`break-words`). An unknown, malformed or
    missing id is a calm not-found with the way back. Focus returns to the opener, or to the
    section heading when the chat left the list; results are announced in the status region;
    wrapped in `Suspense` because of `useSearchParams`), `/[locale]/welcome/` (always reachable; *Start* asks for persistent storage and
    goes to People), `/[locale]/settings/` (language, appearance, app version + archive format version),
    `not-found` → `out/404.html`.
  - Next.js telemetry disabled (`NEXT_TELEMETRY_DISABLED` in scripts, CI and
    `next.config.ts`; `.npmrc` `shell-emulator=true` makes the env prefix work on Windows).
- **CLI:** TypeScript 6 (`strict`), Node 24 ESM (`.nvmrc`), pnpm 11.
  - `commander` — CLI arguments (`cli/index.ts`).
  - `fflate` — streaming raw-DEFLATE `Inflate` behind the ZIP reader
    (`lib/importers/whatsapp/zip.ts`).
  - `date-fns` — timestamp formatting in the parser.
  - `picocolors` — terminal output.
  - `tsup` (bundle `cli/index.ts` to `dist/`), `tsx` (run TS directly), ESLint 10 flat
    config, Vitest 5.
  - TypeScript path alias `@/` → repo root (`tsconfig.json`, `vitest.config.ts`).
- **PWA:** `app/manifest.ts` → `out/manifest.webmanifest` (name, theme colours, icons,
  `share_target` POST multipart for ZIP / TXT). Icons are generated by
  `scripts/generate-icons.mjs` (signed-distance shapes + a tiny PNG encoder on `node:zlib`,
  no image tools): `app/icon.svg`, `app/apple-icon.png`, `public/icons/icon-{192,512}.png`,
  `icon-maskable-512.png`; a test fails when they are stale.
  - **Service worker** (`sw/service-worker.ts`, `serwist`): precaches every file of `out/`
    (pages, RSC payloads, chunks, icons) with `cleanURLs` + `directoryIndex` and all query
    parameters ignored; anything else goes to the network, and failed navigations get
    `/<locale>/offline/` in the URL's language; HEAD prefetch checks are answered from the
    precache; `skipWaiting` + `clientsClaim`.
  - **Build** (`scripts/build-sw.mjs`, after `next build`): esbuild bundles the worker (base
    path baked in), then `@serwist/build` `injectManifest` writes `out/sw.js`. Chosen over
    `@serwist/next` (webpack-only, while Next 16 builds with Turbopack) and
    `@serwist/turbopack` (needs a route handler, i.e. a server). Registered by
    `components/service-worker-registration.tsx` in production builds only.
  - **Share target** (`sw/share-target.ts`): the worker stores accepted files (ZIP / TXT,
    max 20) in the share inbox and answers `303` to `/?to=import&received=N`; the root
    redirect (`redirectPath`, allow-listed targets only) lands on `/<locale>/import/`,
    which offers them in the import wizard.
  - **Storage**: *Start* calls `navigator.storage.persist()`; Settings → *Space on this
    device* shows `navigator.storage.estimate()` and whether storage is persistent.
- **SQLite WASM** (`@sqlite.org/sqlite-wasm` 3.53.4-build2, exact pin; official SQLite
  build, Apache-2.0, no dependencies, no install scripts, ~850 KiB `.wasm`) persisted in the
  browser's **OPFS** through the **SAH-pool VFS** (no COOP/COEP headers, one connection at a
  time), inside a Web Worker. `scripts/build-db-worker.mjs` (run by `pnpm dev` and `pnpm
  build`, before `next build`) bundles `lib/db/worker.ts` with esbuild and copies the
  `.wasm` into `public/db/` (gitignored); `next build` ships both in `out/`, same origin, and
  the service worker precaches them (so the database opens offline). Turbopack cannot bundle
  the package itself (its legacy worker wrapper uses a dynamic `new Worker(new URL(...))`),
  hence the separate esbuild step. The same script bundles the **import worker**
  (`lib/usecases/import-worker.ts` → `public/db/import-worker.js`, ~50 KiB, no SQLite inside). The newer 3.54.x was skipped until it passes the 7-day
  `minimumReleaseAge`.
- **App (planned, Phase 2):** zod 4.
- **Hosting (planned):** Cloudflare Pages for the public URL; GitHub Pages workflow so any fork
  gets its own URL with no secrets.
- **No backend, no accounts, no third-party APIs.** No Google Cloud, no OAuth, no telemetry.

## 2. Layered architecture

- **Platform-neutral core (`lib/`)** — runs in Node and in the browser (Web Worker in
  Phase 2). Inputs are `Blob`s, web `ReadableStream`s and async iterables of lines; no
  `node:*` imports, no `Buffer`/`process`, no React / Next.js.
  - `lib/domain/` — pure types and constants: `archive.ts` (`ARCHIVE_FORMAT_VERSION`),
    `profile.ts` (input bounds and trimming for profile and conversation text: name 100,
    relationship 60, description 2000, title 200; trimmed; single-line fields strip bidi
    controls (WhatsApp wraps unsaved-number authors in them), reject control characters and
    lone surrogates, and required ones need a visible character; `FieldError`),
    `library.ts` (profile / conversation / message types, `isUuid`, `isSha256Hex`,
    `isLocalTimestamp`, `MESSAGE_TYPES`), `fingerprint.ts` (message fingerprints, see below), `sha256.ts` (`createSha256`: incremental SHA-256 in
    plain TS, pinned by NIST vectors; WebCrypto has no incremental digest, so this is how
    media is hashed while it streams, with no dependency).
  - `lib/db/` — the only code that issues SQL. `sql.ts` (`SqlDb`: the narrow sync surface
    over sqlite-wasm's `oo1.DB`, `transaction`), `migrations.ts` (schema v1 to v6,
    `PRAGMA user_version`, forward-only, one transaction per migration, newer DB refused),
    `queries.ts` (profiles: create / update / archive / get / list; conversations: list / rename /
    move / link / unlink; `importMessages` (batch, optional new conversation and "me", all in one transaction), `findImportCandidates`, `findExistingFingerprints`, `undoImportBatch`, `listImportBatches` (read-only history: newest first, keyset `before` cursor, page <= 200, filter by conversation or profile), `listMessages`; the conversation view's reads, all by position on `messages_timeline` with no schema change: `getConversationBounds`, `countMessages`, `getMessageWindow` (limit clamped to 1..500, any offset, window ids from the covering index, then a join of only those rows; carries `isMe`, system flag, media hash/name/mime), `findMessageOffsetByDate` (`null` when every message is earlier), `listConversationDays` (count and first offset per local day), `getMessageSource(conversationId, messageId)` (the first import batch that added the message: source, label, date, batch id; `not-found` unless the pair matches, `invalid` for a malformed id; read-only, no schema change); an unknown conversation is `not-found`; a person's media, also with no schema change: `countPersonMedia` / `listPersonMedia(profileId, kinds, offset, limit)` (messages with a stored file of the asked media types over every conversation linked to the profile, archived or not; total order `(sent_at, ordinal, id)`, limit clamped to 1..500, ids picked first and only that page joined; `invalid` for empty / non-media `kinds`, `not-found` for an unknown profile; ~15 ms first page and count over 15k audio items in a 200k-message archive, guarded by `person-media.perf.test.ts`); a person's combined timeline (schema v4 index `messages_by_time`): `getPersonTimelineBounds`, `getPersonTimelineWindow(profileId, offset, limit)` (every message of every conversation linked to the profile, archived or not, merged in the total order `(sent_at, ordinal, conversation_id, id)`; limit clamped to 1..500; each item is a conversation-view message plus `conversationId` / `conversationTitle`; a conversation linked to two people is in both timelines), `findPersonTimelineOffsetByDate` (`null` when all are earlier), `listPersonTimelineDays`; `not-found` for an unknown profile, `invalid` for a malformed id, offset or date; use cases in `lib/usecases/person-timeline.ts`; guarded by `person-timeline.perf.test.ts`); favorites (schema v5): `setFavorite({ conversationId, messageId, favorite, now })` (the screen passes the local message id; the pair is checked, `not-found` otherwise; resolved to `(conversation, fingerprint)` inside; idempotent), `countFavorites(scope?)` / `listFavorites(scope, offset, limit)` (scope = `{ profileId }`, `{ conversationId }` or none = whole archive, both = `invalid`; timeline-shaped items, oldest first in the timeline order, limit clamped to 1..500; favorites whose message is not in the archive are not returned or counted), and `isFavorite` on every item of `getMessageWindow` / `getPersonTimelineWindow` through a LEFT JOIN on the favorites primary key (page rows only, so no N+1); use cases in `lib/usecases/favorites.ts`; guarded by `favorites.perf.test.ts`); notes (schema v6): `setNote({ target, body, now })` (target = `{ kind: 'profile', profileId }`, `{ kind: 'conversation', conversationId }` or `{ kind: 'message', conversationId, messageId }`, strictly validated; the message pair is checked, `not-found` otherwise, and resolved to `(conversation, fingerprint)` inside; the text is trimmed and bounded by `NOTE_MAX` = 10,000 in `domain/profile.ts` (`invalid` over it, never truncated); creates, edits (keeps `created_at`, moves `updated_at` only when the text changes) or, when empty, deletes and returns `null`), `getNote(target)`, `countNotes(scope?)` / `listNotes(scope, offset, limit)` (scope = `{ profileId }` (the person's own note plus those of their conversations and messages), `{ conversationId }` (its note plus its messages') or none, both = `invalid`; most recently edited first (`updated_at` desc, ties by `created_at` then rowid, so pages tile), limit clamped to 1..500; each item carries kind, text, dates, profile name / conversation title and, for a message note, the message (id, sent_at, type, author, text, file name); notes on a message that is not in the archive are not returned or counted), and `hasNote` on every item of `getMessageWindow` / `getPersonTimelineWindow` / `listFavorites` through a LEFT JOIN on the unique `(conversation_id, fingerprint)` index (page rows only, so no N+1); use cases in `lib/usecases/notes.ts`; guarded by `notes.perf.test.ts`); full-text search (a derived index, no change to the library schema): `getSearchStatus` (`not-built` / `stale` / `ready` plus the message total), `stepSearchIndex({ limit? })` (one chunk of a reconcile pass, default 5,000 messages, clamped to 100..20,000: adds what is missing, removes what is gone or different; `finished` / `verified` end the pass) and `searchMessages({ scope?, query, offset, limit })` (scope = `{ profileId }`, `{ conversationId }` or none, both = `invalid`, unknown = `not-found`; the query is reduced to quoted words with the last one as a prefix from 2 letters, so no FTS5 syntax typed by a person reaches the engine; newest first in the timeline order; limit clamped to 1..500; items are timeline-shaped plus `snippet: { text, ranges }`, plain text with UTF-16 offsets, never HTML; `unavailable` before the first complete pass); use cases in `lib/usecases/search.ts` (`getSearchStatus`, `buildSearchIndex({ onProgress, signal })`, `searchMessages(scope, query, offset, limit)`, which brings a missing or stale index up to date first); guarded by `search.perf.test.ts`),
    `protocol.ts` + `dispatch.ts` (typed request/response messages; no raw SQL crosses the
    boundary), `open.ts` (`openMemoryDb` for Node tests, `openOpfsDb` for the worker),
    `worker.ts` (worker entry) over `serve.ts` (`createDbServer`: the request loop, plus `connect`:
    a `MessagePort` another worker uses to reach THIS connection), `client.ts` (`createDbClient`,
    request ids, `DbError` codes; `createWorkerTransport(url)`, `createPortTransport(port)`,
    `DbClient.connectPort()`). The same migrations and queries run against the
    in-memory database in Node tests and the OPFS one in the browser.
  - `lib/log.ts` — `createLogger(scope)`; the only console writer outside `cli/` and
    `scripts/`. Local diagnostics only, never message content.
  - `lib/storage/` — `share-inbox.ts` (Web Share Target files in Cache Storage
    `memory-archive-share-inbox-v1`; names are metadata only, never paths), `quota.ts`
    (`requestPersistentStorage`, `readStorageStatus`), `test-cache-storage.ts` (in-memory
    `CacheStorage` for tests), `blob-store.ts` (`BlobStore` interface, `BlobStoreError`),
    `opfs-blob-store.ts` (`openBlobStore(dir, {sweep?})` / `openOpfsBlobStore({sweep?})`: content-addressed
    blobs in OPFS `memory-archive-blobs/<aa>/<sha256>`, streamed hash-while-write into
    `tmp/` then atomic `move()`, copy+verify fallback with recovery markers, sweep of
    abandoned temp files on open (`sweep:false` for a second, concurrent opener), only valid 64-hex names become paths),
    `test-opfs-directory.ts` (in-memory OPFS directory for tests),
    `thumb-store.ts` / `opfs-thumb-store.ts` / `thumbnail.ts`: the **thumbnail cache**, a DERIVED cache of
    gallery-tile pictures in its own OPFS directory `memory-archive-thumbs/<sha256>-<size>` (size tag
    = longest side in px; only `320` exists), never inside `memory-archive-blobs/`. Decisions: it is
    safe to lose at any time (a miss regenerates); NOT part of the backup/sync ZIP or `serializeDb`
    (both read only the database and `BlobStore`, which cannot see this directory) and a restore
    clears it; not an orphan/foreign blob (`BlobStore.list`, `sweepOrphanBlobs`, `verify` never see it);
    deleted with its blob wherever blobs are deleted (`deleteBlobs` in `import.ts`: undo, orphan
    sweep, rollback), cleared by restore, and any thumbnail whose photo is not stored is reclaimed by
    the orphan sweep (`removeOrphans`, so also by the open-time `sweepLeftovers`) via `ThumbStore.list()`;
    `readTileImage` never serves a thumbnail for a photo that is gone (`blobStore.has` first) and
    removes one written while its photo was being deleted; there is no "erase everything" path yet, which must
    `clear()` it when added. Only 64 lowercase hex hashes + a known size tag become file names;
    writes go to `tmp-<uuid>` and `move()` into place, and `get` serves only a complete webp/jpeg
    (RIFF length / JPEG end marker), dropping anything else. Capped at 128 MiB (a 320 px webp is
    10-40 KB, so thousands of photos), LRU-ish eviction by file time on `put`; the size index is built on
    first need. `makeThumbnail(blob, maxSide)` decodes with `createImageBitmap` resize and `imageOrientation: 'from-image'` (a first 64 px
    decode only learns the orientation), encodes webp (jpeg on white as fallback) with
    `OffscreenCanvas`, and returns `undefined` instead of throwing (HEIC, damaged files, no API).
    `ProfileDeps.thumbStore` is optional; `openLibrary` opens it with `openThumbStore` and a failure
    to open is ignored. Used only through `lib/usecases/tile-image.ts` (`readTileImage`: cache hit, else read +
    thumbnail + cache; files under 32 KiB or without a thumbnail are shown as they are) and
    `hooks/use-tile-image.ts`; the lightbox and the conversation always use the full file.
  - `lib/usecases/device-storage.ts` — `prepareDeviceStorage`, `getDeviceStorageStatus`,
    `getSharedFiles`, `takeSharedFile`, `discardSharedFile` (called from `hooks/use-device-storage.ts`); `lib/usecases/archive.ts` —
    `exportArchive`, `restoreArchiveIntoEmptyLibrary` (no UI entry point yet);
    `lib/usecases/profiles.ts` (`createProfile`, `updateProfile`, `archiveProfile`,
    `unarchiveProfile`, `listProfiles`, `getProfileDetails`) and `conversations.ts`
    (`listConversations`, `renameConversation`, `moveConversation`,
    `linkConversationToProfile`, `unlinkConversationFromProfile`): they take a `DbClient`
    (worker protocol), an injectable UUID source and clock, and fail with `DbError` codes
    `invalid` / `not-found`. `test-client.ts` is the structured-clone loopback for their tests.
    `lib/usecases/conversation-view.ts` — `openConversationView` (summary + bounds + participants), `getMessageWindow`, `countMessages`, `findMessageOffsetByDate`, `listConversationDays`, `getMessageSource` (where a message came from), and `readBlob(deps, sha256, hint)` (a stored blob as a typed `Blob`, `not-found` / `invalid`; no DOM, the UI makes the object URL); `lib/usecases/conversation-media.ts` — `blobSize` (size of a stored blob for the size chip, `undefined` when missing). `lib/usecases/person-media.ts` — `countPersonMedia`, `listPersonMedia` (a person's media across their conversations; bytes via `readBlob` / `blobSize`).
    `lib/usecases/library.ts` — `openLibrary` (worker + database check + blob store opened with
    `sweep:false` + the open-time cleanup `sweepLeftovers`, with test seams; the returned `Library`
    also has `importWorkerUrl`, `connectPort()`, `isBusy()` and a `close({force?})` that refuses with
    `busy` while an archive operation runs), `libraryProblemOf` (error → reason the UI explains), `listPeople` (profiles split
    active / archived with conversation counts, plus `unassigned` conversations), `getPersonDetails`
    (one person + their conversations + everyone; `undefined` for an unknown or malformed id);
    `conversations.ts` also has `listConversationRows` / `withParticipants` (summaries with
    participant names; read-only compositions); the UI never imports `lib/db`.
    Import off the main thread (`import-client.ts`, `import-protocol.ts`, `import-worker-core.ts`,
    `import-worker.ts`, `import-space.ts`) and its read-only preview (`import-preview.ts`): see
    "Workers topology" and "Import preview" below.
  - `lib/db/snapshot.ts` — `serializeDb`, `loadSnapshot`, `listBlobs`, `isLibraryEmpty`.
  - `lib/exporters/archive/` — `format.ts` (manifest, limits, `ArchiveError`, path validation),
    `write.ts` (`writeArchive`, fflate streaming `Zip`), `read.ts` (`restoreArchive`).
  - `lib/importers/whatsapp/` — `zip.ts` (single ZIP reader: central directory + ZIP64 over
    `Blob.slice`, fflate streaming inflate per entry), `lines.ts` (UTF-8 decoding + line
    splitting), `timestamp.ts`, `message.ts` (state machine), `chat.ts` (transcript entry,
    chat name/slug), `media.ts` (media matching), `import.ts` (`parseWhatsAppZip`).
  - `lib/importers/legacy/` — readers for old outputs back into `Message[]`:
    `readLegacyJson` (schema 0 and 1, refuses newer), `readLegacyHtml` (the `chat-data`
    island), `readLegacyCsv` (5 and 6 columns), `readLegacyOutput` (dispatch; Markdown is
    refused as lossy).
  - `lib/exporters/legacy/` — wa-backup output formats as pure functions: `csv.ts`,
    `json.ts`, `md.ts`, `html.ts`, `media.ts` (media map, MIME), `colors.ts` + `sha256.ts`.
- **Node CLI (`cli/`)** — `index.ts` (bin entry) → `main.ts` (`buildCli`, commander with
  positional options): the default import command, `import-legacy <file>` and
  `render <dir>` (`cli/legacy.ts`). Plus the `fs.openAsBlob` adapter, CSV/media/output
  writing and link-title fetching. Pipeline (`cli/pipeline.ts`): `parseWhatsAppZip` →
  `mergeCsv` → `enrichTitles` → `reconcileMedia` → `renderOutputs`.
- **Why the ZIP reader uses the central directory** — WhatsApp exports store members with
  data descriptors; a forward-only reader (fflate `Unzip`) must guess where such a member ends
  and splits a stored inner `.zip` into bogus entries (regression test in `zip.test.ts`).
- **CSV as source of truth** — `messages.csv` (`timestamp_iso,type,author,text,media,url_titles`),
  merged and deduplicated on every run; JSON / Markdown / HTML are re-rendered from it.
- **Versioned JSON envelope** — `schemaVersion` (1) + `generator` in `messages.json` and the
  HTML island; schema in [`formats/legacy-json.md`](formats/legacy-json.md). The version
  constants live in `lib/exporters/legacy/version.ts` (a test keeps them in sync with
  `package.json`).
- **Shared browser scripts** — `lib/exporters/legacy/js/{linkify,transcript,xss-sanitize}.js`
  run both in Node and in the generated HTML. `scripts/build-viewer-script.mjs` concatenates
  them into one classic script, committed as `js/viewer-script.generated.ts` (`VIEWER_SCRIPT`)
  and inlined by `html.ts`, so no file is read at runtime (the old runtime read broke the built
  CLI). `pnpm build` regenerates it; a test fails when it is stale.
- **Link titles** (`cli/titles.ts`) — opt-in (`--fetch-titles`), the CLI's only network
  access. `guardedFetch` allows only http(s), resolves the host and refuses private /
  loopback / link-local / CGNAT / multicast / ULA targets, re-checks every redirect (max 3)
  and reads at most 512 KB. Stored titles are never wiped; only missing ones are fetched.
- **Message types** — `text`, `photo`, `video`, `sticker`, `document`, `audio` (`.opus`,
  `.m4a`, `.mp3`, `.ogg`, `PTT-*`, `AUD-*`), `system`, `deleted`, `omitted`.
- **Layers** (enforced by ESLint, see §3):
  `app/` → `components/` → `hooks/` → `lib/usecases/` → `lib/domain/` · `lib/db/` ·
  `lib/storage/` · `lib/importers/<source>/` · `lib/exporters/`. UI may also use
  `lib/domain` types and `i18n/`; only use cases compose db / storage / importers /
  exporters.
- **Schema v1 (implemented, `lib/db/migrations.ts`)** — `profiles` (UUID), `conversations`
  (UUID), `conversation_profiles` (many-to-many), `participants` (per conversation, explicit
  optional `profile_id`), `messages` (`UNIQUE(conversation_id, fingerprint)` = idempotent
  import, ordered by `sent_at, ordinal, id`), `blobs` (sha256 + size + mime; bytes live in
  OPFS), `import_batches` (history, added / skipped counts; belongs to a conversation and is deleted with it, since `source_label` may hold a person's name). Foreign keys are on; ids,
  hashes, timestamps and message types are also CHECK-constrained. The database only stores and
  de-duplicates by the fingerprint; computing it is `lib/domain/fingerprint.ts`.
- **Schema v2 (implemented, expand-only)** — `profiles` gains `relationship` and
  `description` (`NOT NULL DEFAULT ''`) and `photo_sha256` (nullable, `REFERENCES blobs`,
  hex CHECK): the photo is an ordinary content-addressed blob, registered in `blobs` in the
  same transaction as the profile write. Length bounds live in `lib/domain/profile.ts`, not in
  CHECKs, so they can change without a migration. Profiles are archived (`archived_at`), never
  deleted. Moving a conversation edits `conversation_profiles` rows only (one transaction);
  messages, media, participants and `is_group` are never touched (participant links are
  independent of how a conversation is filed; remapping on move is a follow-up). A v1 archive restores by
  migrating the scratch snapshot (`loadSnapshot`); the archive `formatVersion` stays 1 and the
  manifest `schemaVersion` is now 2 for new backups.
- **Storage model** — SQLite holds the structured data (later migrations add timeline
  events, associations, favorites, annotations, meta). Media are **content-addressed blobs**,
  implemented in `lib/storage` (`opfs-blob-store.ts`): OPFS `memory-archive-blobs/<aa>/<sha256>`
  sharded by the first two hex characters, written through `tmp/` and published atomically
  with `move()` (copy fallback with a `pending-<sha>` marker, re-verified on the next open).
  `put` keeps an existing same-size blob and replaces only a size-mismatched copy;
  same-size bit-rot is reported by `verify()`, not healed. The backup ZIP layout is separate (see Archive file).
  Source data is separate from user-defined associations.
- **Schema v3 (implemented, expand-only)** — `conversations.source_key` (the importer's stable
  "same chat" key, apart from `title` so a rename does not break matching; `''` = never matched),
  `participants.is_me` (the author the user said is themselves; at most one per conversation),
  `import_batches.created_conversation` (the batch created its conversation, so undo removes it
  once empty), plus indexes `messages(batch_id)`, `messages(media_sha256)` and
  `conversations(source, source_key)` for undo and matching. All defaulted: v1 and v2 backups
  restore by migrating the scratch snapshot; the archive `formatVersion` stays 1 and new backups
  carry `schemaVersion` 3.
- **Schema v4 (implemented, expand-only)** — one index, no column or row: `messages_by_time ON
  messages(sent_at, ordinal, conversation_id)` (the rowid `id` is the implicit last key). It is the
  person timeline's total order and covers its membership test, so a window walks it in order with
  no sort and no table lookup for the OFFSET skip. Chosen by `EXPLAIN QUERY PLAN` and timing on 200k
  messages (3 of 4 conversations linked to the person, last page): `(sent_at, ordinal, conversation_id)`
  16 ms, `(sent_at, id)` 31-36 ms, no new index (planner's sort of all linked conversations) 60 ms.
  The planner does not pick the index by itself, so the query names it (`INDEXED BY`); the worst
  case is a person with a small share of the archive (it walks the index past other people's rows):
  25% of 200k, last page, 17 ms. Measured on the 200k archive: first page 1 ms, middle 9 ms, far
  offset 17 ms, date jump 1.4 ms, bounds 13 ms, days (250) 32 ms. v1-v3 backups restore by
  migrating (the index is built once); the archive `formatVersion` stays 1 and new backups carry
  `schemaVersion` 4, so an older app refuses them (`newer-schema`).
- **Schema v5 (implemented, expand-only)** — one table, `favorites(conversation_id, fingerprint,
  created_at, PRIMARY KEY (conversation_id, fingerprint)) STRICT`, empty after migrating. A favorite
  is anchored by the message's fingerprint within its conversation, never by the local integer
  `messages.id`, so it survives backup / restore and the future device sync (messages travel by
  fingerprint). A media favorite is a favorite message that has media. There is deliberately no
  foreign key to `messages`: undoing a batch (or a re-import) must not lose it, so a favorite whose
  message is gone is dormant (no read returns or counts it) and returns with the message. It is
  deleted only with its conversation (`ON DELETE CASCADE`): undoing the import that created a
  conversation, or removing the conversation, drops its favorites. Dormant rows are not cleaned up
  (a few bytes each; a cleanup would defeat undo then re-import). `created_at` is a UTC instant
  from the caller. Measured on 200k messages with 2k favorites (1%): windows unchanged (conversation
  1 / 2.4 / 2.4 ms at start / middle / end, person timeline 1 / 9 / 18 ms), count 2 ms, favorites page
  4 ms. The list query pins `favorites` as the driving table with `CROSS JOIN` (the planner's default
  walked the whole archive: 134 ms for a last page). v1-v4 backups restore by migrating; new backups
  carry `schemaVersion` 5, so an older app refuses them (`newer-schema`).
- **Schema v6 (implemented, expand-only)** — one table, `notes(kind, profile_id, conversation_id,
  fingerprint, body, created_at, updated_at) STRICT`, empty after migrating: one editable text on a
  person, a conversation or a message. Real foreign keys with `ON DELETE CASCADE` on `profile_id` and
  `conversation_id` (instead of a generic `target_key`, so the database itself refuses a note of
  nothing); a CHECK ties each `kind` to exactly its columns; one note per target by unique indexes
  (`profile_id`; `(conversation_id, fingerprint)`; `conversation_id` where `kind = 'conversation'`;
  NULLs are distinct so kinds never collide). A message note is anchored like a favorite, by
  `(conversation_id, fingerprint)` with NO foreign key to `messages`, so undoing an import and
  importing again does not lose it; a note whose message is gone is dormant (no read returns or counts
  it) and returns with the message. It is deleted with its conversation (undoing the import that
  created a conversation drops the conversation's and its messages' notes, like favorites); profiles
  are archived, never deleted, so the profile cascade only guards the invariant. An empty text is
  never stored and the 10,000-character bound is the application's, not a CHECK. Notes are personal
  text and live in the SQLite snapshot, so they are in every backup and restore (intended; see
  `docs/privacy.md`); text is never logged. Measured on 200k messages with 2k message notes (1%):
  windows unchanged (conversation 1 / 2.6 / 2.5 ms at start / middle / end, person timeline 1 / 9 / 18
  ms), count 2 ms, notes page 4-5 ms. v1-v5 backups restore by migrating; new backups carry
  `schemaVersion` 6, so an older app refuses them (`newer-schema`).
- **Search: a derived index (decision, no schema change)** — full-text search runs on an FTS5 table that is
  a rebuildable CACHE, not data. FTS5 is compiled into the bundled sqlite-wasm. It could not live in the
  library: `snapshot.ts` refuses virtual tables, triggers and views in anything restored, and backups
  serialize `main`, so an FTS table there would break every restore and ship derived text in every backup.
  So it lives in its own database file, `search.sqlite3`, in the same SAH-pool directory as
  `library.sqlite3` (`OPFS_SEARCH_FILE`, `lib/db/search.ts`). The worker's one connection runs
  `ATTACH DATABASE '/search.sqlite3' AS search` while an operation uses it and `DETACH`es afterwards on a
  real library (so a library transaction never spans two files: no second journal or super-journal on
  imports; Node tests attach `:memory:` and keep it). `serializeDb` exports `main` only and
  `userTables` / `isLibraryEmpty` read `main`'s catalog, so the index is in no backup, no sync pack and no
  integrity check; a snapshot that carries a virtual table is still refused (tested). The pool does not
  grow by itself (default 6 files; two databases need journals, a super-journal and temp files), so
  `openOpfsDb` reserves 12 (`reserveMinimumCapacity`; failing to get them only makes search `unavailable`).
  Table `docs(text, fp UNINDEXED)`, `rowid` = `messages.id`, tokenizer `unicode61 remove_diacritics 2`
  (case and accents fold: `canço`, `CANÇÓ`, `canco` match each other; `canción` is another word),
  `prefix = '2 3'` (without it a prefix query merges every word that starts with it: about twice as slow), `text` =
  body plus the media file name, `fp` = first 16 hex digits of the fingerprint; a `meta` table holds the
  layout `version` (a different value drops and recreates the index) and `built` (set after the first
  complete pass). Staleness has no triggers: message ids are reused after an undo (INTEGER PRIMARY KEY
  without AUTOINCREMENT), so a row is trusted only while the message with that id still has that `fp`
  (search joins on it, so a stale index can miss new messages but never shows the text of another one), and
  a pass reconciles by id ranges (delete rows whose message is gone or has another `fp`, insert the missing
  ones, drop rows past the last id). "Is it current" is this connection's `total_changes()`: remembered
  after a pass that saw no outside write, any difference means `stale`; a new process remembers nothing, so
  the first search after opening verifies once. That is fail-safe and also fires for favorites and notes
  (a re-check is the anti-join only). **Retention rule:** text must not outlive its message in `search.sqlite3`.
  Whenever messages are removed or replaced, the index is dropped first (`discardSearchIndex`: `DROP` the
  tables, `VACUUM search`, so no table and no free page remain; status goes back to `not-built` and the next
  search rebuilds, about 3 s for 200k): the `undoImportBatch` handler calls it before the undo, `loadSnapshot`
  before copying a restore. It is a no-op when no index file exists (known at open from the pool's file
  list, or from the first attach): nothing is attached or created. The index database is opened with
  `secure_delete = ON` and `journal_mode = MEMORY` because a rollback journal in a pool slot keeps old pages
  after it is deleted; the price is that a crash can damage the file, so a pass writes a `dirty` mark before
  its first chunk and clears it with its last, and a mark found with no pass in this process resets the
  index. Any other failure reading it (not a database, damaged FTS5 shadow tables, attach failure) resets
  once (OPFS: the file is unlinked; memory: a fresh attach) and retries; only a second failure reports
  `unavailable`. If a discard itself fails the file is reset on next use. Chunks are synchronous handlers like every other op and the page
  loops (`buildSearchIndex`; callers share one run, each abort rejects only its own caller and the run stops when all have aborted), so the worker answers other requests between chunks and the UI can show
  `done / total`. Query safety: `lib/domain/search-query.ts` keeps only letters, digits and marks, makes
  each word a quoted string (`OR`, `NEAR`, `text:`, `-`, `*`, quotes are just words or dropped), bounds the
  query (200 characters and 8 words in all; words are never truncated); snippets are cut in JS around the first match
  (`snippetOf`, mirrors the tokenizer) because FTS5's `snippet()` with a rowid filter re-walks the whole match
  set (about 6 ms per row at 200k). Measured on 200k messages (`lib/db/search.perf.test.ts`, Node, in memory):
  build 0.3 s, 14.6 MiB, selective queries 0.1-3 ms, a word in every message 100 ms. In Chrome on real OPFS
  with 200k messages of 4-15 words (Zipf vocabulary): build 2.9 s in 41 chunks (slowest 156 ms), selective queries 2.5-5 ms, words that match a third or more of the archive 0.6-0.9 s
  (every match is sorted by time before the page is cut), re-check after any change 1.0 s. Erasing the
  library must delete `search.sqlite3` (see `docs/privacy.md`); there is no "erase everything" path yet.
- **Message fingerprint (version 1, `lib/domain/fingerprint.ts`; a data format)** — SHA-256 over
  the length-prefixed UTF-8 encoding (4-byte big-endian length + bytes per field) of
  `[version, minute, author, type, text, mediaName, occurrence]`.
  `minute` = local time as parsed, cut to the minute (Android has minutes, iOS seconds: the common
  denominator; no timezone invented). `author` = NFC, bidi / format marks removed (ZWSP, LRM, RLM,
  ALM, U+202A-E, U+2066-9, BOM; ZWJ and ZWNJ kept as content), no-break spaces to a plain space,
  spaces collapsed, leading `~` dropped, case kept; system messages have no author.
  `text` = NFC, same marks removed, line endings `\n`, trailing whitespace per line and blank
  edges trimmed (the caption for media messages). `mediaName` = the attachment's base name (never
  the bytes' hash, so a message keeps its identity with or without its file: export without media,
  `skipVideos`, missing file). `occurrence` = how many messages with the identical key came before
  it in the SAME export (0, 1, 2, ...): WhatsApp times have minute resolution, so two identical
  messages in a minute stay two messages. Frozen test vectors (cross-checked with `node:crypto`)
  pin it; changing anything is a data migration (bump `FINGERPRINT_VERSION`, keep the old
  algorithm for old archives). Known limits (each pinned by a test): edited messages are new
  messages; if one of several identical messages is deleted between two exports the later ones
  shift down one occurrence, so a genuinely new identical message in that minute can be skipped
  as already stored; an export that starts mid-minute inside such a run restarts its indexes at 0;
  the minute is the phone's wall-clock text, so the same message exported from another time zone
  or across a clock change imports as new; a contact exported as a number and later as a saved
  name (or renamed) is a different author, so its messages import again; an export made without
  media replaces the attachment line with an "omitted" marker (a different message, new
  `omitted` rows), it does not match the earlier photo rows.
- **Import, batches, undo (`lib/usecases/import.ts`)** — `importWhatsAppExport` parses the ZIP
  (bounded: entries, directory, transcript, per-media size; `openZipEntry` stops an entry that
  inflates past its declared size), decides the conversation, streams only the media that is needed
  into the blob store (hashed on the way; identical bytes stored once across conversations and
  profiles; media of messages already there is not read again; a file missing from the ZIP keeps
  its message with `media_sha256` NULL), then saves in ONE transaction (`importMessages`: batch,
  new conversation, participants, messages, `INSERT ... ON CONFLICT DO NOTHING`). Summary:
  `added`, `alreadyThere`, `mediaAdded`, `mediaSkipped`, `mediaMissing`, `videosSkipped`,
  `rawLines` (timestamp-shaped lines with an unusable date, kept as text). Conversation matching
  (`auto`): same source, filed under one of the target profiles (or none), same `source_key` (the
  chat name without the per-language export prefix, case-folded) AND at least one of up to 200
  sampled fingerprints of the export already stored in it (a name is never proof: different chats
  share names, and phones call exports `chat.zip`). Several key matches (`same-title`), a single
  key match with no overlap (`same-title-no-overlap`) or no key match but overlap in another
  conversation (`overlap`) return `ambiguous` (nothing written). A single key match whose
  sampled fingerprints find no overlap is looked up once more with ALL of the export's
  non-system fingerprints (a newer export may share only a handful of messages) before
  `same-title-no-overlap`;
  `{mode:'existing'|'new'}` is the caller's explicit choice. Import history (`usecases/import-history.ts`, no schema change): `listImportHistory` adds profile names to `listImportBatches`; a batch is listed until undone (undo deletes its row), a re-import that added nothing and created nothing is not listed, `messagesPresent` / `canUndo` come from `messages_by_batch`, per-batch media added/skipped are not recorded (only `mediaPresent`); `undoImport` is `undoImportBatch` (same guard and lock). `undoImportBatch` removes the batch's
  messages, participants only it brought (not profile-linked, not "me"), the conversation it created
  once empty, and blobs nothing else references (messages, profile photos); transactional and
  idempotent. Interruption: blobs are written before the transaction; abort (`AbortSignal`) or an
  error before the save leaves the database untouched and removes the blobs this run wrote; a lost
  connection at the save is ambiguous, so those blobs stay until `sweepOrphanBlobs` (deletes store
  blobs with no `blobs` row). Import, undo, sweep, export, restore and profile writes that carry
  a photo all take the same `withArchiveGuard(blobStore, work, lock?)` (second concurrent call in
  this tab: `busy`). The cross-tab part is an injected `ArchiveLock` (`deps.lock`, try-lock
  semantics, `{held:false}` = typed `busy`); `openLibrary` wires `navigator.locks` when it exists
  (`webArchiveLock`), and the guard lives in `archive-guard.ts` so UI code can import it without
  pulling SQLite. Sweep guarantees: never deletes a blob the database references and never
  overlaps another archive operation; it does NOT protect a photo blob stored but not yet saved
  with its profile. `openLibrary` runs `sweepLeftovers` (blob store `tmp/` + orphans, see "Open-time cleanup"). Date reading: the day/month order is decided from the WHOLE transcript
  (`createFormatDetector`, a first constant-memory pass): one date with a component >= 13
  anywhere settles it. Only a genuine tie (every date reads both ways) is `ambiguous`; in `auto`
  mode that returns `ambiguous` / `date-format` BEFORE any write, with both readings of the first
  such date (`datePreview`), and the caller passes `dayFirst` or `monthFirst` (both together:
  `invalid`). An explicit conversation target does not refuse a tie; `dateFormat
  {dayFirst, ambiguous}` reports it. Lines whose date fails under the chosen order are kept as
  text of the previous message and counted in `rawLines` (one before the first message is counted
  but has nowhere to attach). Hostile ZIPs: a ZIP problem in any phase is a typed `ImportError`
  (`limit-exceeded` for a size lie or bound, `invalid-export` for a damaged entry), with the
  database unchanged and this run's blobs removed. Progress callback:
  `{phase: reading | media | saving, done, total}`, plus `bytes` / `totalBytes` in `media` (updated
  inside a big file, at most every 200 ms).
  Known limits: re-import never fills media a message was stored without (`skipVideos`, files
  missing from the ZIP): undo and import again; undoing the batch that created a conversation
  removes the messages a later overlapping export re-contained, and undoing the first of several
  batches can leave an empty conversation; `maxChatBytes` (256 MiB) is far too high for a phone
  and all messages cross the worker boundary in one request (memory risks: lower the browser
  default, chunk requests).
- **Workers topology (Phase 4)** — three threads, ONE SQLite connection:
  - *Page*: UI, `DbClient`, the busy guard, `estimateImport`. Opens the blob store with the default
    sweep of `tmp/`.
  - *DB worker* (`db/worker.js`): the only SQLite (SAH pool allows one connection). Answers the page
    on its own channel and any number of `MessagePort`s the page hands it with
    `{type:'connect', port}`. Requests from every port run one at a time (each handler is synchronous),
    so two senders never interleave inside a transaction.
  - *Import worker* (`db/import-worker.js`, one per import, terminated at the end): parse, inflate,
    sha256 and blob writes (OPFS sync access handles) off the page's thread. Its `DbClient` talks over
    the port the page brokered (`DbClient.connectPort()` creates the `MessageChannel`, keeps no end,
    sends one to the DB worker and returns the other to be transferred to the import worker). It opens
    the blob store with `sweep:false`: a second opener must not delete the page's in-flight temp files,
    and the page's next open removes what a crashed worker left. It takes the `navigator.locks`
    archive lock itself; the page holds its in-tab guard for the same span, so a restore, undo or
    second import is `busy` in this tab and in other tabs.
  - Protocol (`import-protocol.ts`): page → worker `start {input, dbPort}` (the ZIP is a `Blob`
    reference, not a copy), `preview {input, dbPort}` (read-only, see "Import preview") and `cancel`;
    a worker runs ONE job, an import or a preview; worker → page `progress`, `done {result}` or `error`
    (`ImportError` / `DbError` / `ArchiveError` / `BlobStoreError` codes survive; an abort resolves to
    the caller's `signal.reason`). Cancel aborts the same `AbortSignal` the in-thread import uses:
    before the save step the archive is unchanged; a cancel that arrives during the single save
    transaction lets it commit and the import resolves normally: once a `saving` progress event has
    been seen the client arms no grace timer (and clears a pending one) and waits for `done` / `error`,
    however long the save takes. Messages from the worker are untrusted: the client dispatches on
    `event.type`, ignores unknown ones, and a malformed `error` still settles as `worker-failed`.
  - Failure: a crashed or unloadable worker, or one that ignores a cancel for 15 s, rejects with
    `ImportError` `worker-failed`. Archive: the whole batch or nothing; written media may be orphans
    for `sweepOrphanBlobs`; running the import again is safe (fingerprints and hashes dedupe).
  - Space (`estimateImport(zip, storageStatus)`): reads only the central directory; needed =
    uncompressed bytes × 1.1 + 32 MiB + the largest file (a browser without `move()` holds one blob
    twice at the peak); "video" is the importer's own rule (`isVideoFileName` in
    `importers/whatsapp/message.ts`, the one `skipVideos` uses, judged on the base name), so `.m4v`
    / `.avi` without a VID-/VIDEO marker are not videos; available = quota − usage (null when unknown: never blocks);
    reports video bytes and whether "import without videos" would fit. An upper bound: media already
    stored is not stored twice.
  - Open-time cleanup (`sweepLeftovers` in `import.ts`, called by `openLibrary`): the blob store's
    `tmp/` (`BlobStore.sweepTemp`, the store is opened with `sweep:false`) AND `sweepOrphanBlobs`'
    work run ONLY while holding the archive lock (try-lock, `ifAvailable`) and the in-tab guard; the
    import worker holds that lock for its whole run, so a reload, a second tab or a retried open
    never deletes the temp files or uncommitted blobs of a running import. If the lock is taken, the
    guard is busy or the browser has no Web Locks it is skipped silently (the next open tries again);
    a cleanup that fails is logged without data and does not fail the open. It runs in the
    BACKGROUND, started when the library is handed out and not awaited (`Library.cleanup` resolves when
    it ends and never rejects), so a slow orphan cleanup never counts toward `OPEN_TIMEOUT_MS` or
    holds the connection of an abandoned open; it holds the in-tab guard from the start, so an import
    begun meanwhile is `busy`. `Library.close()` THROWS `ArchiveError busy` while an archive operation
    (the cleanup included) runs in this tab (closing stops the database
    worker, which would leave an import worker waiting forever on its port); `close({force:true})`
    is for `pagehide` / unmount / retry (`use-library.tsx`). The import worker URL is the database
    worker's URL with the file name replaced (`importWorkerUrlOf`: both are built into `public/db/`).
  - Wizard follow-ups (done in the wizard PR except where marked): pre-select `suggestedMe` visibly, never apply it silently (it is wrong
    when the exporter's own entry is a bare number next to a saved contact); authors beyond the cap
    (`authorsTruncated`) cannot be picked as "me"; `use-library.tsx`'s retry force-closes without
    aborting a running import (it cannot reach the wizard's signal: the wizard must cancel first; still open: the wizard has no Retry handle on the library while running);
    show code-based copy, never the raw internal error `message`;
    `estimateImport` and `suggestSkipVideos` are heuristics; `importWhatsAppExportInWorker`,
    `previewWhatsAppExportInWorker`, `estimateImport` and `createImportWorkerTransport` have no
    non-test caller until the wizard PR (the wizard now calls them); the DB worker's end of the brokered port is not closed when
    the import worker terminates (a small leak until GC).
  - Limits: no heartbeat, so a worker killed by the OS is only noticed when the person cancels (15 s
    grace); if the DB worker dies, the import worker's pending calls hang until that cancel; messages
    still cross as one `importMessages` request (see above).
- **Import preview (`lib/usecases/import-preview.ts`)** — `previewWhatsAppExport(deps:{client},
  input, {signal, onProgress})`: read-only look at an export for the wizard. No blob store in its
  deps (it cannot store media), only `listConversations`, `findImportCandidates` and
  `findExistingFingerprints` on the `DbClient` (no new database operation), no archive lock. One
  streaming pass over the transcript (`streamWhatsAppZip`, the generator `parseWhatsAppZip` now
  collects; format pass + parse pass, constant memory) keeping only fingerprints, a capped author
  table and media names. Shares the import's code, not just its rules: `createMessageDrafter`
  (fingerprints), `matchConversation` (the `auto` rule), `guessIsGroup` (> 2 distinct authors),
  `matchMediaEntries`, `estimateImport` (space), the same limits; so `duplicates.alreadyThere` /
  `wouldAdd` equal the import's `alreadyThere` / `added` (tested for same ZIP twice, a newer export,
  same-minute repeats, system messages, a sample that misses the overlap, chunked matching).
  Result: `chatTitle`, `sourceKey`, `isGroup`, `messageCount` (system messages included),
  `firstAt` / `lastAt`, `authors [{name, messageCount, looksLikePhoneNumber}]` (most active first,
  capped at `MAX_PREVIEW_AUTHORS` = 200, `authorsTruncated`, a truncated chat is a group),
  `suggestedMe` (`suggestMe`: only a two-person chat with exactly one author that is not a phone
  number; otherwise null), `dateFormat {dayFirst, ambiguous, preview?}`, `rawLines`, `media {byKind,
  totalCount, totalBytes, missing}` from the central directory (`classifyFromFilename`, the importer's
  rule), `space` (`ImportSpaceEstimate`; `storage` numbers are an input, null = unknown) and
  `duplicates`: `new` | `existing {conversationId, title, storedCount, alreadyThere, wouldAdd}` |
  `ambiguous {reason, candidates}` | `date-format` (a genuine date tie in `auto` mode: no library
  lookup, same order as the import). Explicit `conversation` targets work like the import's (`new`,
  `existing`, not-found). Errors are the import's (`invalid-export`, `limit-exceeded`, `invalid`).
  Worker: `previewWhatsAppExportInWorker(deps:{client, blobStore}, input, {workerUrl, signal,
  onProgress, cancelGraceMs})` shares `runWorkerJob` with the import client (same `worker-failed` /
  grace / typed-error / abort semantics, one worker per job, terminated at the end); events
  `preview-progress {phase: reading | matching}` and `preview-done`. Concurrency decision: no lock and
  no guard of its own (two previews can run together, and an import may start during one: the answer is
  advisory and the import decides again under the lock), but it is refused with `ArchiveError busy`
  while an archive operation runs in this tab (a restore swaps the library it would read; a preview
  during an import describes a library about to change). Cross-tab it needs nothing: only one tab can
  hold the database. A killed worker or an abort leaves nothing (nothing is written; tests compare
  every table and the blob store before and after). Limits: fingerprints are O(messages) in memory
  (64 chars each), `warnings` strings are collected like the import does, and the transcript is
  read twice.
- **Archive file (v1, implemented as a PoC in `lib/exporters/archive/`)** —
  `memory-archive-YYYY-MM-DD.zip`: `manifest.json` first (deflated; `format`, `formatVersion`,
  `createdAt`, `app`, `schemaVersion`, `entries[{path,size,sha256}]`), then `db/library.sqlite`
  and `blobs/<aa>/<sha256>` per `blobs` row, all stored uncompressed (media is already
  compressed; exact byte counts make caps simple). Export and restore share an in-process
  busy guard per library (a second concurrent call fails with `busy`), and export reads the
  media list, schema version and database bytes back to back so they describe one moment, then
  refuses with `limit-exceeded` anything restore's limits would refuse (entry count, database,
  largest blob, total, directory size; overridable via the same `limits` option).
  Restore (`restoreArchiveIntoEmptyLibrary`) refuses a library that has rows
  (`target-not-empty`); media files in the store without any database row are leftovers of an
  interrupted import or restore and are swept first. It checks limits before reading anything
  big: declared entry count and central directory size (`readZipEntries` options `maxEntries`,
  `maxCentralDirectoryBytes`, ZIP64 included), then per entry from the directory
  (`MAX_ENTRIES`, `MAX_TOTAL_BYTES`, `MAX_ENTRY_BYTES`, `MAX_DATABASE_BYTES` for
  `db/library.sqlite`, `MAX_COMPRESSION_RATIO`), validates paths and the manifest, requires
  ZIP entries and manifest to match exactly, counts and hashes real bytes while streaming,
  loads the database last (`lib/db/snapshot.ts`: scratch copy with `trusted_schema` off,
  triggers / views / virtual tables refused before migrating, integrity and foreign-key checks,
  migrate, one-transaction copy with per-table row counts verified) and deletes the blobs it
  stored if anything fails (a delete that fails is reported as `leftoverBlobs` on the error and
  swept by the next restore). Newer `formatVersion` / `schemaVersion` are refused. PoC limits: the export is
  assembled in memory; restore into a non-empty library (merge) and change packs for manual
  sync are not implemented.
- **Read-only viewer is separate from the archive** — the portable HTML viewer is an export,
  never the storage format.

## 3. Architecture as code

- **ESLint** (`eslint.config.js`) — `@eslint/js` recommended + `typescript-eslint`
  recommended.
  - `lib/**` (non-test): browser + worker globals; `no-restricted-imports` bans every Node
    built-in (`node:*`, `fs`, `path`, …) and imports from `cli/`; `no-restricted-globals`
    bans `Buffer`, `process`, `__dirname`, `require`, ….
    `lib/**` also bans `react`, `react-dom`, `next`, `next-intl`, `lucide-react`,
    `@radix-ui/*`.
  - `local/require-test-file` (inline plugin in `eslint.config.js`) — every module in
    `lib/importers/**` needs a sibling `*.test.ts` (`index.ts`, `types.ts` exempt).
  - `boundaries/dependencies` (`eslint-plugin-boundaries` 7, default `disallow`) — elements
    `app`, `components`, `hooks`, `i18n`, `messages`, `usecases`, `domain`, `db`, `storage`,
    `importers`, `exporters`, `cli`, `sw`, `shared` (files directly in `lib/`); the allowed
    edges are `LAYER_POLICIES` in `eslint.config.js`. Resolution via
    `eslint-import-resolver-typescript` (`@/` alias).
  - `import-x/no-cycle` (`eslint-plugin-import-x`).
  - `i18next/no-literal-string` (`jsx-text-only`) in `app/**/*.tsx` and
    `components/**/*.tsx`.
  - `no-console` everywhere except `lib/log.ts`, `cli/`, `scripts/`, tests and configs.
  - `scripts/eslint-architecture.test.ts` lints snippets against the real config and proves
    each rule above fires (and allowed imports pass).
- **Planned:** `local/require-test-file` extended to `lib/usecases`.

## 4. Tests

- **Runner:** Vitest 5 (`vitest.config.ts`), tests next to the code as `*.test.ts(x)`;
  assertions mostly `node:assert/strict` (carried over) and Vitest `expect`.
  `pnpm test` = generate fixtures + `vitest run`. Two projects: `node` (`lib/`, `cli/`,
  `scripts/`, `i18n/`) and `dom` (`app/`, `components/`, `hooks/` on **happy-dom**,
  lighter than jsdom). Component tests render with `react-dom/client` + `act`
  (`components/test-utils.tsx`), no testing library.
- **Fixtures:** synthetic only — `scripts/generate-fixtures.mjs` (run by `pnpm test`) writes
  the chats and ZIPs into the git-ignored `fixtures/`. Real exports are never committed.
  `FORMAT_FIXTURES` covers one root-level ZIP per export style: Android en-US (M/D/YY,
  `AM`/`PM`, `(file attached)`, system lines, multiline, identical same-minute messages),
  iOS en-US with and without media (U+202F before `AM`/`PM`, U+200E system lines), Android
  es (`p. m.`), iOS es (`<adjunto: …>`), Android pt (24h, no comma) and Android ca
  (best-effort strings).
- **Real-data guard:** `scripts/no-real-data.test.ts` scans every git-tracked text file and fails on any
  valid Brazilian CPF number or on a denylist of scrubbed real names/credentials (stored as sha256
  hashes of normalized word sequences, so the test does not reintroduce them).
- **Test types:**
  - Importer units (`lib/importers/whatsapp/*.test.ts`) — `timestamp`, `lines` (chunk
    boundaries, CRLF, UTF-8), `zip` (data descriptors, ZIP64, corrupt input), `chat`,
    `media`, `message`, `import`, `formats` (every message of every format fixture:
    detection + classification).
  - Legacy readers — `lib/importers/legacy/*.test.ts` (schema 0/1, newer refused, escaped
    islands, 5/6-column CSV, Markdown refused).
  - Round trips — `cli/legacy.test.ts`: fixture ZIP → outputs → delete CSV →
    `import-legacy` from JSON and from HTML (in place and `--out`) → byte-identical CSV;
    `render <dir>`; also in `pnpm smoke` against the built CLI.
  - CLI format runs — `cli/formats.test.ts` (each format fixture end to end: media copied,
    idempotent re-import, identical same-minute messages counted, not collapsed).
  - Platform neutrality — `lib/platform.test.ts`: scans `lib/` for Node imports/globals and
    runs importer + exporters from a `Blob` with `Buffer`/`setImmediate` removed.
  - Exporter units — `lib/exporters/legacy/legacy.test.ts` (sha256 vs `node:crypto`, CSV,
    media map, inline loader), `js/linkify.test.ts`.
  - CLI end to end (`cli/*.test.ts`) — `tracer`, `classify`, `integration` (merge, dedupe,
    idempotent second run), `csv`, `media`, `html-media`, `render` (XSS stays inert),
    `theme`, `titles` (mocked `fetch`), `titles-guard` (SSRF guard, redirects, kept titles),
    `regressions` (one block per fixed known bug).
  - Packaging — `scripts/build-viewer-script.test.ts` (bundle fresh and self-contained) and
    `pnpm smoke` (built CLI).
  - Thumbnails — `lib/storage/opfs-thumb-store.test.ts` (hash/size validation, get/put/delete/clear, cap and LRU eviction, partial write never served, failed write, no-`move()`, tmp sweep, separate from blobs), `thumbnail.test.ts` (fake `createImageBitmap` / `OffscreenCanvas`: orientation, webp / jpeg fallback, undecodable, closing), `lib/usecases/tile-image.test.ts`, `hooks/use-tile-image.test.tsx`, and in `import.test.ts` / `archive.test.ts` (thumbs deleted with their blob, not in the exported ZIP, restore from an empty or stale cache).
  - UI — `components/person-timeline-screen.test.tsx` and `hooks/use-person-timeline.test.tsx` (merge order across two conversations, label only where the conversation changes with hrefs, hostile title as text, "me" alignment, date jump, saved position, empty / not-found / error + retry, start at date / saved position / end, Catalan); e2e `e2e/person-timeline.spec.ts` (two chats imported into one person, order, labels, date jump, calendar, Back, small DOM at 390 and 1440).
  - UI — `components/person-gallery-screen.test.tsx` (kinds, month groups, near-screen reads and URL revoke with a driven IntersectionObserver, video reads nothing, missing and undecodable, Show more, empty / not-found / error + retry, Catalan), `components/person-gallery-lightbox.test.tsx` (dialog stub for happy-dom: open, arrows, ends, missing, read-ahead and revoke, focus return, next page and its failure), `hooks/use-near-viewport.test.tsx`, `e2e/person-gallery.spec.ts` (real PNGs and a video, lazy loading on scroll, keyboard, lightbox open / arrows / Escape / next page / open in the conversation, at 390 and 1440 px);
  - UI — `components/message-notes.test.tsx`, `hooks/use-note.test.tsx` and `components/person-notes-screen.test.tsx` (note button on messages only, 44 px, Ctrl+Enter save with unchanged row positions, `hasNote` patched in place, delete and discard confirmations, failed write keeps the text, `invalid` shown, counter near the limit only, draft survives a remounted row, timeline rows save in their own conversation, conversation and person notes, Notes list kinds / quoted message / hrefs / edit / delete with live note / paging / empty / error + retry / not-found, Catalan), `e2e/notes.spec.ts` (message note in the conversation, listed and edited in Notes, person note, delete, reload keeps it, at 390 and 1440 px)
  - UI — `components/message-favorite.test.tsx` and `hooks/use-favorite-toggle.test.tsx` (star on messages only, aria-pressed, optimistic mark with unchanged row positions, persisted, rollback with live message, in-flight taps ignored, timeline rows save in their own conversation, page read later keeps the mark, Catalan), `components/person-favorites-screen.test.tsx` and `hooks/use-person-favorites.test.tsx` (month groups, text as text, media line, hrefs, remove with live note and failure alert, Show more without skips, empty / error + retry / not-found), `hooks/message-pages.test.ts` (`PageCache.update`, `messageKey`), `e2e/favorites.spec.ts` (star from the Timeline and the conversation, Favorites list, remove, reload keeps it, at 390 and 1440 px)
  - UI — `components/person-audio-screen.test.tsx` and `hooks/use-person-media.test.tsx` (month groups, Open-in-conversation hrefs, one player at a time, missing file, Show more, empty / not-found / error + retry, Catalan; paging, kinds, failed page, ids), `e2e/person-audio.spec.ts` (import, sections link, play one at a time, open in the conversation, at 390 and 1440 px); `components/person-screen.test.tsx` (details, not-found, archived person, edit, archive,
    rename validation / double submit / failure / Escape and IME, move, link, unlink incl. the last
    person, busy guard, focus and live-region behaviour), `components/people-screen.test.tsx`
    (list / link to the person / empty / create / validate / edit /
    archive with confirmation / restore / failures / welcome switch / unassigned section / library unavailable, over
    the real use cases on in-memory SQLite via `renderWithLibrary`), `components/import-screen.test.tsx`
    (the whole wizard over the real use cases and the REAL import worker core via
    `createLoopbackImports` in `lib/usecases/test-client.ts`: files, each step, back/forward state, guess
    pre-selected, ambiguous match, date question, no-fit and skip videos, cancel (early and late), progress
    announcements, results, undo, a queue with a failing file, an archive that changed), `lib/usecases/import-wizard.test.ts`,
    `hooks/use-library.test.tsx`
    (provider states, lazy open, retry), `components/*.test.tsx` (welcome actions incl.
    persistence request and navigation, theme picker / sync, `redirectPath` allow-list, `formatBytes`), `hooks/theme.test.ts` (the inline theme
    script), `i18n/routing.test.ts` (`pickLocale`).
  - PWA — `sw/share-target.test.ts` (stores only ZIP/TXT, 303 redirect, malformed POST,
    offline page per locale, locales in sync), `lib/storage/*.test.ts` (share inbox,
    quota), `lib/usecases/device-storage.test.ts`, `scripts/generate-icons.test.ts`.
  - Offline behaviour (load once → offline → reload / navigate / fallback, share POST while
    offline, base-path build) verified manually with Playwright; see the PR.
  - Conversation view reads — `lib/db/conversation-view.test.ts` (order, ties, edges, date jump, days) and the performance guard `lib/db/conversation-view.perf.test.ts`: a deterministic 200,000-message synthetic conversation (`lib/db/synthetic-archive.ts`, one `INSERT ... SELECT`, constraints on, ~1 s; `VITEST_PERF_COUNT` shrinks it) asserts `EXPLAIN QUERY PLAN` uses `messages_timeline` (covering, no temp b-tree for the window) and budgets of 12-40x the measured times (window at offset 199,900 about 7 ms, date jump 6 ms, `listConversationDays` 44 ms for 1,000 days, `countMessages` 20 ms; Apple silicon, Node 24).
  - Favorites — `lib/db/favorites.test.ts` (stored by conversation + fingerprint, same fingerprint in another conversation, idempotent, pair check, scopes and order, paging, `isFavorite` in both windows, newer export keeps it, undo leaves it dormant and a re-import revives it, conversation undo cascades), `lib/usecases/favorites.test.ts` and the 200k guard `lib/db/favorites.perf.test.ts`; schema in `migrations.test.ts` (pinned DDL, v4 → v5 keeps rows and equals a fresh schema, rollback) and `snapshot.test.ts` (v4 snapshot restores into v5, v5 round-trips favorites, orphan / malformed refused).
  - Search UI — `components/search-screen.test.tsx`, `components/search-highlight.test.tsx` and `hooks/use-search.test.tsx` (debounce with fake timers, Enter at once, minimum length, stale answer ignored, accent-less query, marks from ranges with hostile text, paging 50 + Show more, empty / error + Retry / unavailable, index progress, Cancel, resume, abort on unmount, stale index copy, scopes and links, not-found) and `e2e/search-ui.spec.ts` (390 and 1440 px: import a synthetic ZIP, search from People, "Preparing search" seen on first use, open a result, scoped search from the person page and the conversation header).
  - Search — `lib/domain/search-query.test.ts` (quoting and prefix rule, operators / `NEAR` / `OR` / `-` / `*` / quotes / column filters are only words, bounds on 1M-character input, snippets cut with ranges, markup and control characters stay text, a cut never splits a surrogate pair, long words are kept whole), `lib/usecases/search.test.ts` (status not-built / stale / ready, progress, abort and continue, shared build, accents and case, prefix, scopes, paging, file names, undo, id reuse never shows another message's text, hostile queries, an export carries no index, restore into an empty library then search rebuilds, restore starts the index over, ids that hold other content never show old text, abort semantics for joined builds, a snapshot with an FTS5 table is refused), `lib/db/search.test.ts` (a write between chunks leaves the pass unverified, a pass resumed after an outside write finds the new message, an undo leaves no table and no free page and costs nothing without an index, damaged / wrong-shaped / cut-short indexes reset and rebuild), the 200k guard `lib/db/search.perf.test.ts` and `e2e/search.spec.ts` (real OPFS: attach / search / detach next to an import, built index survives a reload, undo).
  - Notes — `lib/db/notes.test.ts` (one per target, edit keeps `created_at`, same text is a no-op, empty deletes, bound and control characters, hostile text as data, pair check and unknown targets, scopes and order, tiling pages, `hasNote` in both windows and the favorites list, newer export keeps it, undo leaves it dormant and a re-import revives it, conversation undo cascades), `lib/usecases/notes.test.ts` and the 200k guard `lib/db/notes.perf.test.ts` (plan probes `notes_one_per_message` for the page rows only); schema in `migrations.test.ts` (pinned DDL and indexes, v5 → v6 keeps rows and equals a fresh schema, kind/column CHECKs, uniqueness, cascades, rollback) and `snapshot.test.ts` (v4 and v5 snapshots restore into v6, v6 round-trips all four kinds, orphan / malformed refused).
  - Person timeline — `lib/db/person-timeline.test.ts` (merge order across conversations, ties, tiling windows, date jump, days, other people's conversations, move / link / unlink, archived person, invalid input), `lib/usecases/person-timeline.test.ts` and the 200k guard `lib/db/person-timeline.perf.test.ts` (plan must be the covering `messages_by_time` walk with no temp b-tree).
  - Database — `lib/db/*.test.ts` run the real sqlite-wasm in memory under Node:
    migrations (empty → latest, idempotent re-run, failed migration rolls back, every
    earlier version → latest, newer version refused, frozen `sqlite_master` snapshot),
    constraints (incl. `import_batches` cascading with its conversation), queries (re-import and
    overlapping import add nothing twice, atomic import, hostile text, pagination), and the
    client through a structured-clone loopback (ids, out-of-order replies, errors, worker
    failure, throwing transport, malformed params → `invalid`, unknown targets → `not-found`).
    Schema v2 to v6: v1 → v2, v2 → v3, v3 → v4, v4 → v5 and v5 → v6 migrations keep rows (v4 only adds the timeline index and
    the schema equals a fresh one), v1, v2 and v3 snapshots restore into the latest schema, a failed migration rolls back, v1 and v2 DDL snapshots are frozen
    and the latest is pinned separately. `lib/domain/fingerprint.test.ts` holds the frozen
    fingerprint vectors and the stability / distinctness cases;
    `lib/usecases/import.test.ts` covers same ZIP twice, newer export, same-minute repeats,
    cross-format match, media dedupe, missing media, `skipVideos`, ambiguity, abort / thrown error /
    database refusal / lost connection, sweep, undo (shared blobs, merges, idempotence), the busy
    guard against restore, and a backup round trip with imported data. Use cases (`lib/usecases/profiles.test.ts`,
    `conversations.test.ts`) run on in-memory SQLite: validation bounds, archive / unarchive,
    move / link / unlink with message counts and rows unchanged, group chats, archived targets. `scripts/build-db-worker.test.ts`
    builds the worker bundles and checks they contain no remote URL (and the import worker no SQLite).
    `lib/db/serve.test.ts` (real `MessageChannel`s: connect, shared connection, typed errors over a
    port, open retry), `lib/usecases/import-client.test.ts` (the real import worker core on in-memory
    SQLite and blob store through a structured-clone loopback: progress order, idempotent re-import,
    COOPERATIVE cancel / crash, HARD kill mid-media (orphan blob until the sweep) and during the save
    (batch whole), fake-timer checks of the 15 s grace, cancel during save and the throttle,
    untrusted worker messages, typed errors, busy guard and lock),
    `lib/usecases/import-space.test.ts` (synthetic central directories), `lib/usecases/import-preview.test.ts`
    (preview counts equal the real import's, ambiguous matches, phone authors, caps, limits, abort) and the
    preview half of `import-client.test.ts` (loopback + real `MessagePort`s: abort, crash, hard kill, busy),
    the open-time cleanup and `close` tests in `library.test.ts`. The OPFS VFS only
    exists in a browser, so it is verified manually (headless Chrome, see the PR).
  - No remote resources — `lib/exporters/legacy/legacy.test.ts` scans the generated
    `messages.html`; `pnpm smoke` scans every HTML/CSS file in `out/` and asserts `out/db/worker.js`,
    `out/db/import-worker.js` and `out/db/sqlite3.wasm` exist and are precached by `out/sw.js`.
  - Archive — `lib/exporters/archive/archive.test.ts` (round trip row by row and blob by
    blob, layout, hostile archives: traversal / absolute / backslash / drive letter, duplicates,
    unlisted or missing entries, tampered blob / database, size mismatch, bad manifest, newer
    format / schema, entry / size / database / directory / ratio limits including a bomb that
    lies about its size, truncated and corrupt ZIPs, corrupt SQLite, leftover-media sweep and
    retry, non-empty target; each asserts the specific error code and that the target stays
    empty), `lib/db/snapshot.test.ts` (older-schema migration with a synthetic migration list,
    newer schema, triggers / views / virtual tables, extra / missing tables and columns,
    foreign-key and integrity failures, negative rowids, atomic rollback),
    `lib/usecases/archive.test.ts` (busy guard, concurrent restores).
  - Blobs — `lib/domain/sha256.test.ts` (NIST vectors, million-`a`, every length 0-200
    against WebCrypto, chunking) and `lib/storage/opfs-blob-store.test.ts` (the OPFS adapter
    on the in-memory directory in four capability combinations: writable / sync access
    handle, with / without `move()`): known digest, dedupe and idempotent put, stream error
    leaves nothing, corrupt blobs (same-size ones are left for `verify`) and truncated ones (replaced), invalid names rejected (traversal, case,
    length), list / delete, multi-chunk streaming, concurrent puts, sweep, copy-fallback
    crash recovery, copy-fallback failure paths (write error, corrupt copy, short write),
    a throwing sweep. Real OPFS only exists in a browser, so it is not covered by unit tests.
  - Tooling — `scripts/block-agent-github-review-writes.test.ts` (the hook script, run end
    to end with the stdin JSON agents send), `check-i18n-parity.test.ts`,
    `serve-out.test.ts` (base path, 404, no path traversal), `eslint-architecture.test.ts`. The vendored `security-audit` validators have
    their own `node --test` suite.
  - End to end — `e2e/*.spec.ts` (Playwright `@playwright/test`, not part of `pnpm check`):
    `pnpm build` then `pnpm e2e` drives the built `out/` served by `pnpm preview`, in the
    system Google Chrome (`channel: 'chrome'`, no browser download), projects `mobile-390`
    (390x844, touch) and `desktop-1440`. Each test has a fresh context (fresh OPFS); the shared
    fixture in `e2e/fixtures.ts` listens on the browser context (pages, workers, service worker) and fails a test on any request Chrome makes to a non-local origin; `e2e/guard.spec.ts` proves it can fail. It says nothing about traffic outside the browser. Covers
    welcome → Start → People, create + reload (OPFS persistence), edit, archive with
    confirmation, restore, person page empty state, Escape closes the form, a cold open of /ca/ finds the
    library made on /en/, the language picker, a Catalan run, offline reload, no horizontal overflow and a 60-character
    unbroken name, and the import wizard (`e2e/import.spec.ts`: a synthetic ZIP built with fflate and set
    on the file input; import into a new person, summary, person page count, offline reload; same ZIP again =
    already in the archive, 0 added; undo asks first and removes the conversation; a TXT left out; Catalan) and the import history
    (`e2e/history.spec.ts`: same ZIP twice = one entry and unchanged counts; a newer export adds only the difference; undo from
    the history; Catalan; and the Phase 4 check: a 2,300-message ZIP with 300 files of 64 kB built once per worker; after a real progress signal (files copied > 0) closing the tab / reloading leaves exactly 0 conversations and an empty history, and importing again ends with every message once; the all-or-nothing guarantee itself is held by the table-state tests in `lib/usecases/import.test.ts`). Screenshots on failure only; `test-results/` and `playwright-report/` are
    git-ignored. Firefox and WebKit projects come in Phase 6 with a browser install step.
- **Planned:** an automated run of the PRD acceptance scenario (backup → restore on a clean
  browser) in e2e.

## 5. CI/CD and branches

- **Branch model:** feature branch → squash into `dev` → release PR `dev` → `main` titled
  `release: vX.Y.Z` (squash) → tag. `main` only contains release commits
  ([`branching-and-releases.md`](branching-and-releases.md)).
- **Actions are pinned by commit SHA** (`# vN` comment beside each); update them deliberately.
- **`ci.yml`** — on PRs to `dev`/`main` and pushes to `dev`: pnpm install (frozen lockfile,
  7-day release age) → on PRs `scripts/check-pr-preflight.mjs` (blocking: real exports, personal
  media, `.env` files, weakened ignores; full-history checkout) → `pnpm check`. A separate `e2e` job installs, builds and runs
  `pnpm e2e` (Chrome preinstalled on `ubuntu-latest`); on failure it uploads the Playwright
  report and screenshots as an artifact.
- **`branch-policy-guard.yml`** — `pull_request_target`; `main` only accepts PRs from `dev` of this repository (not a fork's `dev`)
  titled `release: vX.Y.Z`.
- **`release.yml`** — on push to `main`: reads the version from the commit subject, creates the
  tag and GitHub Release, back-merges `main` into `dev` (`-s ours`). No release bot.
- **`dependabot.yml`** — npm and GitHub Actions, target `dev`, 7-day cooldown.
- **`CODEOWNERS`** and **PR template** (`.github/pull_request_template.md`).
- **`pages.yml`** — on push to `main` (and manually): `pnpm build` with
  `NEXT_PUBLIC_BASE_PATH=/memory-archive`, uploads `out/`, deploys to GitHub Pages
  (`https://rwxce.github.io/memory-archive/`). Only released versions are published.
- **Planned:** `deploy.yml` (Cloudflare Pages: `main` = production, `dev` = preview).

## 6. Quality gates and supply chain

- **`pnpm check`** — i18n parity (`scripts/check-i18n-parity.mjs`: same keys, same ICU
  placeholders, no empty strings in `messages/{ca,es,en}.json`) → lint → typecheck
  (`next typegen` + `tsc`) → test → build (CLI + app) → smoke (`scripts/smoke.mjs` runs the
  built `dist/` CLI on the fixture ZIP and checks the four outputs + media, then checks every
  locale page in `out/` and that no HTML/CSS loads a remote resource, that the manifest has
  its icons, a maskable icon and the share target, and that `out/sw.js` precaches every
  page).
- **`pnpm preview`** — `scripts/serve-out.mjs`, a dependency-free static server for `out/`
  on `127.0.0.1` (honours `NEXT_PUBLIC_BASE_PATH`, serves `404.html`, refuses path
  traversal).
- **Exact versions** (`.npmrc` `save-exact=true`, `engine-strict=true`), **`minimumReleaseAge`
  of 7 days** (`pnpm-workspace.yaml`, 10080 minutes), exact security **`overrides`**,
  **`allowBuilds`** allowlist for install scripts, `scripts/only-pnpm.mjs` (`preinstall`, dependency-free; replaced `npx only-allow pnpm`).
- New dependencies need a reason in the PR description; prefer no dependency.
- `@playwright/test` (devDependency, exact pin) runs the e2e suite against system Chrome:
  it needs no install script and no browser download, and sends no telemetry.
- `ajv` is a direct devDependency only as a workaround: pnpm 11 drops `ajv-formats`' optional
  peer and `rulesync` crashes without it. Remove when upstream fixes the peer.
- Install scripts denied with a reason in `allowBuilds`: `@swc/core`, `@parcel/watcher`
  (via next-intl / tsup) and `unrs-resolver` (via the import resolver) — their prebuilt
  binaries come from platform-specific optional dependencies.
- ESLint ignores the generated agent folders (`.claude/`, `.codex/`, `.cursor/`,
  `.opencode/`, `.agents/`) and `.rulesync/`.

## 7. AI tooling

- **rulesync — single source** — edit `.rulesync/`, run `pnpm rulesync`; it generates
  `AGENTS.md`, `CLAUDE.md` and the per-tool folders for Claude Code, Codex CLI, Cursor and
  OpenCode. CI fails on drift (`pnpm rulesync:check`). Config: `rulesync.jsonc`. Details:
  [`ai-tooling.md`](ai-tooling.md).
- **Root rule** — `.rulesync/rules/CLAUDE.md`.
- **Subagents** (`.rulesync/subagents/`):
  - `core-architect` — mandatory owner of the data layer: parser, model, storage, importers,
    exporters, use cases.
  - `testing-expert` — tests, fixtures, regressions.
  - `responsive-ui-designer` — router for UI work (mobile-first PWA, `ca`/`es`/`en`).
- **Commands — PR flow** (`.rulesync/commands/`): `pr-plan` → `pr-precheck` → `pr-make` →
  `pr-review` → `pr-triage`.
- **Skills** (`.rulesync/skills/`): `debugging`, `interview-me`, `pr-scope`, `pr-review`,
  `security-audit`, `rulesync`. Planned with the UI: a design skill and `local-test`
  (Playwright, mobile + desktop viewports).
- **Hooks** (`.rulesync/hooks.jsonc`):
  - `PreToolUse` (fail-closed) — `scripts/block-agent-github-review-writes.mjs`: agents
    cannot post GitHub comments or reviews. An unparseable payload or a missing script blocks
    (exit 2; the command resolves the root from `$CLAUDE_PROJECT_DIR`). It understands `gh`
    global flags (`-R`), `--field`/`--raw-field`, `curl --json` and `fetch`/HTTP-client calls
    to `api.github.com`; it is a best-effort guard, not a sandbox.
  - `Stop` (advisory) — lint, `scripts/check-pr-preflight.mjs --advisory`.
  - `SessionEnd` — kills dev processes on the Conductor workspace ports.
- **Permissions** (`.rulesync/permissions.jsonc`) — read-only `gh` allowed; `gh` comment,
  review and mutating `gh api` denied (also with `-R`/`--repo`); `.env*`, secrets, build
  output, `fixtures/`, outputs, any WhatsApp export (`_chat.txt`, `WhatsApp Chat*.txt`, ZIPs)
  read-denied, including `cat`-style reads through the shell. A `codexcli` block restates the rules in a form Codex
  can enforce. **Ignore list** (`.rulesync/.aiignore`, deprecated upstream) only feeds
  `.cursorignore`.
- **MCP servers** (`.rulesync/mcp.jsonc`) — Playwright only, pinned (not `@latest`, which would
  bypass the 7-day release age).
- **Review checklist** — `.rulesync/checks/memory-archive-review.md` (privacy, untrusted input,
  data integrity, supply chain); generates `.cursor/BUGBOT.md` and feeds `pr-precheck` /
  `pr-review`.
- **Known gaps** — OpenCode's generated plugin pipes no payload, so the GitHub-write guard
  allows an empty payload and only the permission denies apply there; Codex has no project-level slash commands.

## 8. Working rules (people and agents)

- **Plan and "go"** — a written plan and an explicit go-ahead before any edit.
- **Data layer goes through `core-architect`.**
- **Privacy first** — never read, copy or commit real chats or personal media; synthetic
  fixtures only. No network calls from the app except an explicit user opt-in.
- **Never lose data** — imports are transactional and idempotent; nothing is silently
  dropped (unparseable lines are kept as raw text).
- **Kill the dev servers you start.**
- **Git** — no commits without authorization; PRs into `dev`; agents merge only when explicitly asked and never post reviews.
- **Language** — reply in the user's language; code, commits, PRs, docs and `.rulesync/` in
  English.

## 9. Product and copy

- [`PRODUCT.md`](../PRODUCT.md) — mission, users, principles.
- [`prd.md`](prd.md) — full product requirements (multi-profile, imports, backup/restore,
  screens, acceptance criteria).
- [`tone.md`](tone.md) — voice rules for UI copy in `ca` / `es` / `en`.
- [`privacy.md`](privacy.md) — what stays where, and what the app never does.

## 10. Reference documents (`docs/`)

- `roadmap.md` — phases 0–9 with scope, PR breakdown and verification.
- `branching-and-releases.md` — branch and release procedure.
- `ai-tooling.md` — rulesync layout and how to add rules, skills and commands.
- `formats/legacy-json.md` — the versioned `messages.json` envelope and what each legacy output
  can be re-imported from.
- `archive/planning/` — the original GSD planning of the wa-backup CLI (phases 1–3, codebase
  map, concerns). Historical, read-only.
- `archive/specs/` — design specs and plans of the CLI features (linkification, link titles,
  thumbnails + lightbox).
