import type { ViewerData } from '../../lib/exporters/viewer/format';
import { h } from './dom';
import { type ConversationSummary, type DateRange, NO_RANGE, type SearchHit, type TimelineMonth, ViewerModel } from './model';
import { appendHighlighted, renderMessage, type RenderContext } from './render';
import { type Locale, makeTranslate } from './strings';
import { findRanges, queryTerms, snippet } from './text';

/**
 * The viewer: profile switcher, conversation list, message thread, search, timeline and date
 * filter, in plain DOM. The thread keeps a bounded window of messages (PAGE per step, at most
 * MAX in the DOM) so a conversation of any length scrolls smoothly.
 */

export interface MountOptions {
  locale: Locale;
  /** Search starts this long after the last keystroke. */
  searchDelayMs?: number;
}

export interface ViewerApp {
  /** Opens a conversation (index in `data.conversations`). */
  open(conv: number): void;
}

const PAGE = 150;
const MAX = 450;
const CONVERSATIONS_SHOWN = 300;
const RESULTS_STEP = 200;

export function mountViewer(root: HTMLElement, data: ViewerData, options: MountOptions): ViewerApp {
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  const t = makeTranslate(options.locale);
  const model = new ViewerModel(data);
  const number = new Intl.NumberFormat(options.locale);
  const longDate = new Intl.DateTimeFormat(options.locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const shortDate = new Intl.DateTimeFormat(options.locale, { year: 'numeric', month: 'short', day: 'numeric' });
  const monthName = new Intl.DateTimeFormat(options.locale, { month: 'long' });
  const dateOf = (sentAt: string, f: Intl.DateTimeFormat) => {
    const y = Number(sentAt.slice(0, 4));
    const m = Number(sentAt.slice(5, 7));
    const d = Number(sentAt.slice(8, 10));
    if (!(y > 0 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return sentAt.slice(0, 10);
    return f.format(new Date(y, m - 1, d, 12));
  };
  const count = (n: number) => (n === 1 ? t('messageOne') : t('messageMany', { count: number.format(n) }));

  // ---- state ----
  let profileId: string | null = null;
  let range: DateRange = NO_RANGE;
  let query = '';
  let terms: string[] = [];
  let onlyHere = false;
  let conv: number | null = null;
  let vis: Int32Array = new Int32Array(0);
  let winStart = 0;
  let winEnd = 0;
  let focusMsg = -1;
  let searchToken = 0;
  let searchLimit = RESULTS_STEP;
  let hits: SearchHit[] = [];
  let hitsTruncated = false;
  let showAllConversations = false;
  /** Opened at the end and not scrolled by the reader yet: images that load keep the end in view. */
  let pinBottom = false;
  let timer: number | undefined;

  // ---- skeleton ----
  const id = (name: string) => `mv-${name}`;
  const status = h(doc, 'p', { class: 'sr-only', attrs: { role: 'status' } });

  const profileSelect = h(doc, 'select', { attrs: { id: id('profile') } });
  const searchInput = h(doc, 'input', {
    attrs: { id: id('search'), type: 'search', placeholder: t('searchPlaceholder'), autocomplete: 'off', enterkeyhint: 'search', spellcheck: false },
  });
  const searchClear = h(doc, 'button', { class: 'btn', text: t('searchClear'), attrs: { type: 'button', hidden: true } });
  const onlyHereBox = h(doc, 'input', { attrs: { id: id('only-here'), type: 'checkbox' } });
  const onlyHereRow = h(doc, 'label', { class: 'check', attrs: { hidden: true } }, [onlyHereBox, h(doc, 'span', { text: t('searchOnlyHere') })]);
  const fromInput = h(doc, 'input', { attrs: { id: id('from'), type: 'date' } });
  const toInput = h(doc, 'input', { attrs: { id: id('to'), type: 'date' } });
  const datesClear = h(doc, 'button', { class: 'btn', text: t('datesClear'), attrs: { type: 'button', hidden: true } });
  const datesNote = h(doc, 'p', { class: 'note-error', attrs: { hidden: true, role: 'alert' } });
  const filters = h(doc, 'details', { class: 'filters' }, [
    h(doc, 'summary', { text: t('dates') }),
    h(doc, 'div', { class: 'row' }, [
      h(doc, 'div', { class: 'field' }, [h(doc, 'label', { text: t('from'), attrs: { for: id('from') } }), fromInput]),
      h(doc, 'div', { class: 'field' }, [h(doc, 'label', { text: t('to'), attrs: { for: id('to') } }), toInput]),
    ]),
    datesClear,
    datesNote,
  ]);
  const profileField = h(doc, 'div', { class: 'field', attrs: { hidden: data.profiles.length < 2 } }, [
    h(doc, 'label', { text: t('profile'), attrs: { for: id('profile') } }),
    profileSelect,
  ]);
  const searchForm = h(doc, 'form', { class: 'search', attrs: { role: 'search', 'aria-label': t('search') } }, [
    h(doc, 'label', { class: 'sr-only', text: t('search'), attrs: { for: id('search') } }),
    h(doc, 'div', { class: 'row' }, [searchInput, searchClear]),
    onlyHereRow,
  ]);
  const convHeading = h(doc, 'h2', { text: t('conversations'), attrs: { id: id('convs') } });
  const convList = h(doc, 'ul', { class: 'convlist' });
  const convMore = h(doc, 'button', { class: 'btn', text: t('conversationsMore'), attrs: { type: 'button', hidden: true } });
  const convNone = h(doc, 'p', { class: 'muted', text: t('conversationsNone'), attrs: { hidden: true } });
  const convNav = h(doc, 'nav', { attrs: { 'aria-labelledby': id('convs') } }, [convHeading, convList, convNone, convMore]);
  const resultsSummary = h(doc, 'p', { class: 'muted' });
  const resultsList = h(doc, 'ul', { class: 'resultlist' });
  const resultsMore = h(doc, 'button', { class: 'btn', text: t('resultsShowMore'), attrs: { type: 'button', hidden: true } });
  const resultsEl = h(doc, 'section', { attrs: { 'aria-label': t('resultsLabel'), hidden: true } }, [resultsSummary, resultsList, resultsMore]);
  const footer = h(doc, 'p', { class: 'muted small', text: t('readOnly', { date: dateOf(data.createdAt, shortDate) }) });
  const sidebar = h(doc, 'aside', { class: 'sidebar' }, [
    h(doc, 'div', { class: 'brand' }, [h(doc, 'h1', { text: t('appTitle') })]),
    profileField,
    searchForm,
    filters,
    convNav,
    resultsEl,
    footer,
  ]);

  const backBtn = h(doc, 'button', { class: 'btn back', attrs: { type: 'button' } });
  const titleEl = h(doc, 'h2', { class: 'title', attrs: { tabindex: -1 } });
  const metaEl = h(doc, 'p', { class: 'muted small' });
  const prevMatch = h(doc, 'button', { class: 'btn', text: t('matchPrev'), attrs: { type: 'button' } });
  const nextMatch = h(doc, 'button', { class: 'btn', text: t('matchNext'), attrs: { type: 'button' } });
  const matchLabel = h(doc, 'span', { class: 'muted small' });
  const matchNav = h(doc, 'div', { class: 'matchnav', attrs: { hidden: true } }, [prevMatch, matchLabel, nextMatch]);
  const yearSelect = h(doc, 'select', { attrs: { id: id('year') } });
  const monthSelect = h(doc, 'select', { attrs: { id: id('month') } });
  const slider = h(doc, 'input', { attrs: { id: id('pos'), type: 'range', min: 0, max: 0, step: 1, value: 0 } });
  const posLabel = h(doc, 'output', { class: 'muted small', attrs: { for: id('pos') } });
  const timeline = h(doc, 'div', { class: 'timeline' }, [
    h(doc, 'div', { class: 'field' }, [h(doc, 'label', { text: t('year'), attrs: { for: id('year') } }), yearSelect]),
    h(doc, 'div', { class: 'field' }, [h(doc, 'label', { text: t('month'), attrs: { for: id('month') } }), monthSelect]),
    h(doc, 'div', { class: 'field grow' }, [h(doc, 'label', { text: t('position'), attrs: { for: id('pos') } }), slider, posLabel]),
  ]);
  // Open on wide screens; on a phone it starts closed so the messages keep the room.
  const timelineBox = h(doc, 'details', { class: 'timeline-box' }, [h(doc, 'summary', { text: t('timeline') }), timeline]);
  if (win.innerWidth > 760) timelineBox.open = true;
  const head = h(doc, 'header', { class: 'thread-head', attrs: { hidden: true } }, [
    h(doc, 'div', { class: 'row top' }, [backBtn, h(doc, 'div', { class: 'grow' }, [titleEl, metaEl]), matchNav]),
    timelineBox,
  ]);
  const earlierBtn = h(doc, 'button', { class: 'btn wide', text: t('earlier'), attrs: { type: 'button', hidden: true } });
  const laterBtn = h(doc, 'button', { class: 'btn wide', text: t('later'), attrs: { type: 'button', hidden: true } });
  const items = h(doc, 'ol', { class: 'items' });
  const emptyNote = h(doc, 'p', { class: 'muted empty', text: t('chooseConversation') });
  const thread = h(doc, 'div', { class: 'thread', attrs: { id: 'thread', role: 'region', 'aria-label': t('messages'), tabindex: 0, hidden: true } }, [earlierBtn, items, laterBtn]);
  const main = h(doc, 'main', { class: 'main' }, [head, emptyNote, thread]);
  const skip = h(doc, 'a', { class: 'skip', text: t('skip'), attrs: { href: '#thread' } });
  const app = h(doc, 'div', { class: 'app', attrs: { 'data-view': 'list' } }, [sidebar, main]);
  root.replaceChildren(skip, app, status);

  // ---- helpers ----
  const announce = (text: string) => {
    status.textContent = text;
  };
  const setView = (view: 'list' | 'thread') => app.setAttribute('data-view', view);
  const renderContext = (): RenderContext => ({
    doc,
    t,
    terms,
    isGroup: conv !== null && (data.conversations[conv].isGroup || data.conversations[conv].participants.length > 2),
    mimeByPath: model.mimeByPath,
  });
  const messageAt = (pos: number) => data.conversations[conv as number].messages[vis[pos]];
  const dayAt = (pos: number) => messageAt(pos).sentAt.slice(0, 10);
  const searchActive = () => terms.length > 0;

  function buildItem(ctx: RenderContext, pos: number, forceDay: boolean): HTMLElement {
    const m = messageAt(pos);
    const li = h(doc, 'li', { class: 'item', attrs: { 'data-pos': pos } });
    if (forceDay || pos === 0 || dayAt(pos) !== dayAt(pos - 1)) {
      const forced = pos > 0 && dayAt(pos) === dayAt(pos - 1);
      li.append(h(doc, 'h3', { class: 'day', text: dateOf(m.sentAt, longDate), attrs: forced ? { 'data-forced': true } : {} }));
    }
    const el = renderMessage(ctx, m, vis[pos]);
    if (vis[pos] === focusMsg) {
      el.classList.add('hit');
      el.setAttribute('tabindex', '-1');
    }
    li.append(el);
    return li;
  }

  /** A forced day heading is only kept while the previous message is outside the window. */
  function unforce(li: Element | null) {
    const heading = li?.querySelector('h3[data-forced]');
    heading?.remove();
  }
  function ensureHeading(li: Element | null) {
    if (!li || li.querySelector('h3.day')) return;
    const pos = Number(li.getAttribute('data-pos'));
    const heading = h(doc, 'h3', { class: 'day', text: dateOf(messageAt(pos).sentAt, longDate), attrs: { 'data-forced': true } });
    li.prepend(heading);
  }

  const itemAt = (pos: number): HTMLElement | undefined => items.children[pos - winStart] as HTMLElement | undefined;

  /** The first item whose bottom edge is below the top of the thread (binary search on offsetTop). */
  function firstVisiblePos(): number {
    const n = items.children.length;
    if (n === 0) return winStart;
    const top = thread.scrollTop;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const el = items.children[mid] as HTMLElement;
      if (el.offsetTop + el.offsetHeight < top) lo = mid + 1;
      else hi = mid;
    }
    return winStart + lo;
  }

  function renderWindow(start: number, end: number) {
    const ctx = renderContext();
    winStart = start;
    winEnd = end;
    const frag = doc.createDocumentFragment();
    for (let pos = start; pos < end; pos++) frag.append(buildItem(ctx, pos, pos === start));
    items.replaceChildren(frag);
    updateEdges();
  }

  function updateEdges() {
    earlierBtn.hidden = winStart === 0;
    laterBtn.hidden = winEnd >= vis.length;
  }

  function scrollToPos(pos: number, block: 'start' | 'center') {
    const el = itemAt(pos);
    if (!el) return;
    const offset = block === 'center' ? Math.max(0, (thread.clientHeight - el.offsetHeight) / 2) : 0;
    thread.scrollTop = Math.max(0, el.offsetTop - offset);
  }

  /** Shows position `pos`: scrolls when it is in the window, otherwise renders a window around it. */
  function showAt(pos: number, block: 'start' | 'center') {
    pinBottom = false;
    pos = Math.min(Math.max(pos, 0), Math.max(vis.length - 1, 0));
    if (pos < winStart || pos >= winEnd) {
      const start = Math.max(0, pos - Math.floor(PAGE / 2));
      renderWindow(start, Math.min(vis.length, start + PAGE));
    }
    scrollToPos(pos, block);
    syncPosition();
  }

  function keepAnchor(change: () => void) {
    const anchor = itemAt(firstVisiblePos());
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    change();
    if (anchor && anchor.isConnected) thread.scrollTop += anchor.getBoundingClientRect().top - before;
  }

  function loadEarlier() {
    if (winStart === 0) return;
    const ctx = renderContext();
    keepAnchor(() => {
      const start = Math.max(0, winStart - PAGE);
      const frag = doc.createDocumentFragment();
      for (let pos = start; pos < winStart; pos++) frag.append(buildItem(ctx, pos, pos === start));
      unforce(items.firstElementChild);
      items.prepend(frag);
      winStart = start;
      while (winEnd - winStart > MAX) {
        items.lastElementChild?.remove();
        winEnd--;
      }
      updateEdges();
    });
    syncPosition();
  }

  function loadLater() {
    if (winEnd >= vis.length) return;
    const ctx = renderContext();
    keepAnchor(() => {
      const end = Math.min(vis.length, winEnd + PAGE);
      const frag = doc.createDocumentFragment();
      for (let pos = winEnd; pos < end; pos++) frag.append(buildItem(ctx, pos, false));
      items.append(frag);
      winEnd = end;
      const keep = firstVisiblePos();
      while (winEnd - winStart > MAX && winStart < keep - 20) {
        items.firstElementChild?.remove();
        winStart++;
      }
      ensureHeading(items.firstElementChild);
      updateEdges();
    });
    syncPosition();
  }

  // ---- timeline ----
  let months: TimelineMonth[] = [];
  function fillTimeline() {
    months = conv === null ? [] : model.timeline(conv, range);
    const years = [...new Set(months.map((m) => m.year))];
    yearSelect.replaceChildren(
      ...years.map((y) => {
        const n = months.filter((m) => m.year === y).reduce((s, m) => s + m.count, 0);
        return h(doc, 'option', { text: `${y} (${number.format(n)})`, attrs: { value: y } });
      }),
    );
    slider.max = String(Math.max(vis.length - 1, 0));
    slider.disabled = vis.length < 2;
    fillMonths(years[years.length - 1]);
  }
  function fillMonths(year: number | undefined) {
    monthSelect.replaceChildren(
      ...months
        .filter((m) => m.year === year)
        .map((m) => h(doc, 'option', { text: `${monthName.format(new Date(2000, m.month - 1, 1))} (${number.format(m.count)})`, attrs: { value: m.month } })),
    );
  }

  /** Reflects the first visible message in the selects, the slider and its label. */
  let syncQueued = false;
  function syncPosition() {
    if (conv === null || vis.length === 0) return;
    const pos = Math.min(firstVisiblePos(), vis.length - 1);
    const sentAt = messageAt(pos).sentAt;
    slider.value = String(pos);
    slider.setAttribute('aria-valuetext', dateOf(sentAt, longDate));
    posLabel.textContent = `${dateOf(sentAt, shortDate)} · ${number.format(pos + 1)} / ${number.format(vis.length)}`;
    const year = Number(sentAt.slice(0, 4));
    const month = Number(sentAt.slice(5, 7));
    if (yearSelect.value !== String(year) && [...yearSelect.options].some((o) => o.value === String(year))) {
      yearSelect.value = String(year);
      fillMonths(year);
    }
    if (monthSelect.value !== String(month)) monthSelect.value = String(month);
  }
  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    win.requestAnimationFrame(() => {
      syncQueued = false;
      syncPosition();
    });
  }

  // ---- conversation ----
  function openConversation(index: number, opts: { msg?: number; focus?: boolean } = {}) {
    const same = conv === index;
    // First: on a phone the thread pane is display:none until the view changes, and a hidden
    // element cannot be scrolled.
    setView('thread');
    conv = index;
    const c = data.conversations[index];
    vis = model.visible(index, range);
    focusMsg = opts.msg ?? -1;
    titleEl.textContent = c.title || t('untitled');
    metaEl.textContent = count(vis.length);
    onlyHereRow.hidden = false;
    head.hidden = false;
    emptyNote.textContent = t('noMessagesInDates');
    thread.hidden = vis.length === 0;
    emptyNote.hidden = vis.length !== 0;
    backBtn.textContent = searchActive() ? t('backToResults') : t('backToList');
    fillTimeline();
    if (vis.length > 0) {
      if (opts.msg !== undefined) {
        const pos = model.positionOf(vis, opts.msg);
        showAt(pos, 'center');
      } else {
        const end = vis.length;
        renderWindow(Math.max(0, end - PAGE), end);
        thread.scrollTop = thread.scrollHeight;
        pinBottom = true;
        syncPosition();
      }
    } else {
      items.replaceChildren();
    }
    markCurrent();
    updateMatchNav();
    if (opts.focus !== false && !same) titleEl.focus({ preventScroll: true });
  }

  function closeConversation() {
    conv = null;
    focusMsg = -1;
    head.hidden = true;
    thread.hidden = true;
    emptyNote.hidden = false;
    emptyNote.textContent = t('chooseConversation');
    onlyHereRow.hidden = true;
    onlyHere = false;
    onlyHereBox.checked = false;
    items.replaceChildren();
    markCurrent();
    setView('list');
  }

  function markCurrent() {
    for (const btn of convList.querySelectorAll('button')) {
      if (btn.getAttribute('data-conv') === String(conv)) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    }
  }

  // ---- conversation list ----
  let summaries: ConversationSummary[] = [];
  function renderList() {
    summaries = model.summaries(profileId, range);
    const shown = showAllConversations ? summaries : summaries.slice(0, CONVERSATIONS_SHOWN);
    convList.replaceChildren(
      ...shown.map((s) => {
        const btn = h(doc, 'button', { class: 'conv', attrs: { type: 'button', 'data-conv': s.index } }, [
          h(doc, 'span', { class: 'conv-title', text: s.title || t('untitled') }),
          h(doc, 'span', { class: 'muted small', text: `${s.last ? dateOf(s.last, shortDate) + ' · ' : ''}${count(s.count)}` }),
        ]);
        if (s.index === conv) btn.setAttribute('aria-current', 'true');
        return h(doc, 'li', {}, [btn]);
      }),
    );
    convNone.hidden = summaries.length > 0;
    convMore.hidden = showAllConversations || summaries.length <= CONVERSATIONS_SHOWN;
  }

  // ---- search ----
  const yieldToUi = () => new Promise<void>((resolve) => win.setTimeout(resolve, 0));

  function renderResults() {
    resultsList.replaceChildren(
      ...hits.map((hit, i) => {
        const c = data.conversations[hit.conv];
        const m = c.messages[hit.msg];
        const shownText = m.text !== '' ? m.text : m.mediaName;
        const sn = snippet(shownText, findRanges(shownText, terms));
        const line = h(doc, 'span', { class: 'snippet' });
        appendHighlighted(doc, line, sn.text, sn.ranges);
        const btn = h(doc, 'button', { class: 'result', attrs: { type: 'button', 'data-hit': i } }, [
          h(doc, 'span', { class: 'conv-title', text: c.title || t('untitled') }),
          h(doc, 'span', { class: 'muted small', text: dateOf(m.sentAt, shortDate) + ' ' + m.sentAt.slice(11, 16) + (m.author ? ` · ${m.author}` : '') }),
          line,
        ]);
        return h(doc, 'li', {}, [btn]);
      }),
    );
    const total = hits.length;
    resultsSummary.textContent =
      total === 0 ? t('resultsNone') : hitsTruncated ? t('resultsMore', { count: number.format(total) }) : total === 1 ? t('resultsFoundOne') : t('resultsFound', { count: number.format(total) });
    resultsMore.hidden = !hitsTruncated;
    announce(resultsSummary.textContent);
  }

  function showSearchUi(on: boolean) {
    resultsEl.hidden = !on;
    convNav.hidden = on;
    searchClear.hidden = !on;
  }

  async function runSearch() {
    const token = ++searchToken;
    terms = queryTerms(query);
    searchClear.hidden = terms.length === 0;
    if (terms.length === 0) {
      hits = [];
      hitsTruncated = false;
      showSearchUi(false);
      rehighlight();
      updateMatchNav();
      return;
    }
    showSearchUi(true);
    resultsSummary.textContent = t('searching');
    const result = await model.search(
      { terms, profileId, onlyConv: onlyHere ? conv : null, range, limit: searchLimit },
      { cancelled: () => token !== searchToken, yieldToUi },
    );
    if (result === null || token !== searchToken) return;
    hits = result.hits;
    hitsTruncated = result.truncated;
    renderResults();
    rehighlight();
    updateMatchNav();
  }

  function scheduleSearch() {
    win.clearTimeout(timer);
    searchLimit = RESULTS_STEP;
    timer = win.window.setTimeout(() => void runSearch(), options.searchDelayMs ?? 200);
  }

  /** Re-renders the visible window so the highlights follow the current terms. */
  function rehighlight() {
    if (conv === null || vis.length === 0) return;
    const pos = Math.min(firstVisiblePos(), vis.length - 1);
    const start = winStart;
    const end = winEnd;
    renderWindow(start, end);
    scrollToPos(pos, 'start');
    backBtn.textContent = searchActive() ? t('backToResults') : t('backToList');
  }

  // ---- matches inside the open conversation ----
  let matchCursor = -1;
  const convHits = () => hits.filter((x) => x.conv === conv);
  function updateMatchNav() {
    const own = conv === null || !searchActive() ? [] : convHits();
    matchNav.hidden = own.length === 0;
    if (own.length === 0) {
      matchCursor = -1;
      return;
    }
    const at = own.findIndex((x) => x.msg === focusMsg);
    matchCursor = at;
    matchLabel.textContent = at >= 0 ? t('matchOf', { n: at + 1, total: own.length }) : t('resultsFound', { count: own.length }).replace(/\.$/, '');
  }
  function gotoMatch(step: number) {
    const own = convHits();
    if (own.length === 0 || conv === null) return;
    const next = matchCursor < 0 ? (step > 0 ? 0 : own.length - 1) : (matchCursor + step + own.length) % own.length;
    focusMsg = own[next].msg;
    rehighlightAt(own[next].msg);
    updateMatchNav();
  }
  function rehighlightAt(msg: number) {
    pinBottom = false;
    const pos = model.positionOf(vis, msg);
    const start = Math.max(0, pos - Math.floor(PAGE / 2));
    renderWindow(start, Math.min(vis.length, start + PAGE));
    scrollToPos(pos, 'center');
    syncPosition();
  }

  // ---- events ----
  convList.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest('button[data-conv]');
    if (btn) openConversation(Number(btn.getAttribute('data-conv')));
  });
  convMore.addEventListener('click', () => {
    showAllConversations = true;
    renderList();
  });
  resultsList.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest('button[data-hit]');
    if (!btn) return;
    const hit = hits[Number(btn.getAttribute('data-hit'))];
    if (hit) openConversation(hit.conv, { msg: hit.msg });
  });
  resultsMore.addEventListener('click', () => {
    searchLimit += RESULTS_STEP;
    void runSearch();
  });
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    win.clearTimeout(timer);
    void runSearch();
  });
  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    scheduleSearch();
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    query = '';
    win.clearTimeout(timer);
    void runSearch();
    searchInput.focus();
  });
  onlyHereBox.addEventListener('change', () => {
    onlyHere = onlyHereBox.checked;
    scheduleSearch();
  });
  profileSelect.addEventListener('change', () => {
    profileId = profileSelect.value === '' ? null : profileSelect.value;
    showAllConversations = false;
    if (conv !== null && profileId !== null && !data.conversations[conv].profileIds.includes(profileId)) closeConversation();
    renderList();
    if (searchActive()) scheduleSearch();
  });
  function applyRange() {
    const from = fromInput.value || null;
    const to = toInput.value || null;
    const reversed = from !== null && to !== null && from > to;
    datesNote.hidden = !reversed;
    datesNote.textContent = reversed ? t('datesReversed') : '';
    range = { from, to };
    datesClear.hidden = from === null && to === null;
    renderList();
    if (conv !== null) openConversation(conv, { focus: false });
    if (searchActive()) scheduleSearch();
  }
  fromInput.addEventListener('change', applyRange);
  toInput.addEventListener('change', applyRange);
  datesClear.addEventListener('click', () => {
    fromInput.value = '';
    toInput.value = '';
    applyRange();
    fromInput.focus();
  });
  backBtn.addEventListener('click', () => {
    setView('list');
    (searchActive() ? searchInput : (convList.querySelector('[aria-current]') as HTMLElement | null) ?? searchInput).focus();
  });
  earlierBtn.addEventListener('click', loadEarlier);
  laterBtn.addEventListener('click', loadLater);
  prevMatch.addEventListener('click', () => gotoMatch(-1));
  nextMatch.addEventListener('click', () => gotoMatch(1));
  timelineBox.addEventListener('toggle', () => {
    if (pinBottom) thread.scrollTop = thread.scrollHeight;
  });
  thread.addEventListener('scroll', queueSync, { passive: true });
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) thread.addEventListener(type, () => (pinBottom = false), { passive: true });
  thread.addEventListener(
    'load',
    () => {
      if (pinBottom) thread.scrollTop = thread.scrollHeight;
    },
    true,
  );
  if (typeof win.IntersectionObserver === 'function') {
    // Loading more as the edge comes into view; the buttons stay for keyboard and assistive tech.
    const io = new win.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // Only when the reader really is near that edge (not while a jump is still settling).
          const nearTop = thread.scrollTop < 400;
          const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 400;
          if (entry.target === earlierBtn ? nearTop : nearBottom) (entry.target as HTMLElement).click();
        }
      },
      { root: thread, rootMargin: '400px 0px' },
    );
    io.observe(earlierBtn);
    io.observe(laterBtn);
  }
  yearSelect.addEventListener('change', () => {
    const year = Number(yearSelect.value);
    fillMonths(year);
    const first = months.find((m) => m.year === year);
    if (first) showAt(first.pos, 'start');
  });
  monthSelect.addEventListener('change', () => {
    const year = Number(yearSelect.value);
    const m = months.find((x) => x.year === year && x.month === Number(monthSelect.value));
    if (m) showAt(m.pos, 'start');
  });
  slider.addEventListener('input', () => {
    const pos = Number(slider.value);
    if (pos >= 0 && pos < vis.length) posLabel.textContent = `${dateOf(messageAt(pos).sentAt, shortDate)} · ${number.format(pos + 1)} / ${number.format(vis.length)}`;
  });
  slider.addEventListener('change', () => showAt(Number(slider.value), 'start'));
  doc.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setView('list');
      searchInput.focus();
    }
  });

  // ---- start ----
  profileSelect.append(
    h(doc, 'option', { text: t('allProfiles'), attrs: { value: '' } }),
    ...data.profiles.map((p) => h(doc, 'option', { text: p.displayName, attrs: { value: p.id } })),
  );
  renderList();

  return {
    open(index: number) {
      if (index >= 0 && index < data.conversations.length) openConversation(index);
    },
  };
}
