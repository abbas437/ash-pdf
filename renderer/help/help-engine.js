// In-app help engine (app-agnostic: copied unchanged into every ASH desktop app; the app talks to it
// through one adapter object). Built content comes from scripts/build-help.mjs (help/ → help-data.js).
//
//   initHelp(adapter)            adapter = {
//     appName,                     'ASH PDF Studio'
//     data,                        help-data.js default export {sections, topics, tours, index, targets, context}
//     targets?: {id: selector | () => Element|null},   overlay on data.targets
//     prepare?: {id: async () => void},                makes a target visible (switch tool, open a panel…)
//     fallback?: (id, el) => Element|null,             visible stand-in for a hidden target (More button…)
//     getPref(key) → value|Promise, setPref(key, value),
//     openUrl(url),                                    external links
//     top?: () => number,                              px from the window top where the panel starts
//     imgBase?: string,                                base URL for img/… (default: this folder)
//     home?: string,                                   topic shown by F1 with no context (default 'welcome')
//     contextOf?: (el) => 'topic[/anchor]'|null,       F1 context for elements without data-help
//     container?: () => Element }                      where the panel and spotlight live (a modal <dialog> in the top layer, else body)
//   openHelp(topicId?, anchor?) / closeHelp() / isHelpOpen()
//   showMe(targetId)             spotlight a control (the panel folds to a tab meanwhile); false if not found
//   startTour(id) / endTour() / helpEvent(name)      tours advance on Next, a click on the target or an app event
//   helpButton(topic[/anchor])   a "?" button for dialog headers
//   contextTopicAt(el)           'topic[/anchor]' from the nearest [data-help]
//   maybeWelcome()               once per install: "New to <app>? Take a 1-minute tour" (pref help.welcomeShown)
// F1 opens the topic of the control under the mouse (or of the open dialog), else the home topic.
// Esc ends a spotlight / tour, or closes the panel when focus is in it.
import { searchHelp } from './help-search.js';

let A = null, D = null;
const topics = new Map();
let panel = null, ui = null;
let hist = [], hpos = -1;
let spot = null;                 // {el, ring, pop, raf, timer, onDown}
let tour = null;                 // {t, i}
let mouse = { x: -1, y: -1 };
const PREFIXES = ['', 'tool:', 'btn:', 'panel:', 'el:', 'menu:', 'cmd:', 'status:'];
const host = () => A?.container?.() ?? document.body;

const mk = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
};

export function initHelp(adapter) {
  A = adapter;
  D = adapter.data ?? { sections: [], topics: [], tours: [], index: [] };
  topics.clear();
  for (const t of D.topics) topics.set(t.id, t);
  if (!document.querySelector('link[data-ash-help]')) {
    document.head.append(mk('link', { rel: 'stylesheet', href: new URL('./help.css', import.meta.url).href, 'data-ash-help': '1' }));
  }
  window.addEventListener('mousemove', (e) => { mouse = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('click', onTourClick, true);
  return { openHelp, closeHelp, showMe, startTour, endTour, helpEvent, helpButton, contextTopicAt, maybeWelcome, isHelpOpen };
}

// ---------------------------------------------------------------- panel
function buildPanel() {
  const search = mk('input', { type: 'search', class: 'ah-search', placeholder: 'Search help', 'aria-label': 'Search help', spellcheck: 'false' });
  const back = mk('button', { type: 'button', class: 'ah-ib', title: 'Back', 'aria-label': 'Back', text: '‹' });
  const fwd = mk('button', { type: 'button', class: 'ah-ib', title: 'Forward', 'aria-label': 'Forward', text: '›' });
  const home = mk('button', { type: 'button', class: 'ah-ib ah-home', title: 'Contents', 'aria-label': 'Contents', text: '☰' });
  const close = mk('button', { type: 'button', class: 'ah-ib', title: 'Close help (Esc)', 'aria-label': 'Close help', text: '×' });
  const body = mk('div', { class: 'ah-body', tabindex: '-1' });
  const tab = mk('button', { type: 'button', class: 'ah-tab', title: 'Back to help', 'aria-label': 'Back to help', text: 'Help' });
  panel = mk('aside', { class: 'ash-help', role: 'dialog', 'aria-label': `${A.appName ?? ''} help`.trim(), 'data-ash-help': '1', hidden: true },
    mk('div', { class: 'ah-head' }, back, fwd, home, search, close), body, tab);
  ui = { search, back, fwd, home, close, body, tab };
  back.addEventListener('click', () => go(-1));
  fwd.addEventListener('click', () => go(1));
  home.addEventListener('click', () => navigate(null));
  close.addEventListener('click', closeHelp);
  tab.addEventListener('click', () => { endSpot(); unfold(); });
  search.addEventListener('input', () => (search.value.trim() ? showResults(search.value) : render()));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = body.querySelector('.ah-result'); if (first) { e.preventDefault(); first.click(); } }
    if (e.key === 'ArrowDown') { const first = body.querySelector('.ah-result'); if (first) { e.preventDefault(); first.focus(); } }
  });
  body.addEventListener('click', onBodyClick);
  host().append(panel);
}

function place() {
  const top = Math.max(0, Number(A.top?.()) || 0);
  panel.style.top = `${top}px`;
}

export function isHelpOpen() { return !!panel && panel.isConnected && !panel.hidden; }

export function openHelp(topicId, anchor) {
  if (!A) return;
  if (!panel) buildPanel();
  endSpot();
  if (panel.parentElement !== host()) host().append(panel);
  place();
  panel.hidden = false;
  unfold();
  const id = topicId && topics.has(topicId) ? topicId : (topicId ? null : (hpos >= 0 ? hist[hpos].id : null));
  if (topicId && !topics.has(topicId)) navigate(null);
  else if (id && (hpos < 0 || hist[hpos].id !== id || anchor)) navigate(id, anchor);
  else render();
  ui.search.focus();
}

export function closeHelp() {
  if (!panel) return;
  endSpot();
  panel.hidden = true;
  panel.classList.remove('ah-folded');
}

const fold = () => panel?.classList.add('ah-folded');
const unfold = () => panel?.classList.remove('ah-folded');

function navigate(id, anchor) {
  hist = hist.slice(0, hpos + 1);
  hist.push({ id, anchor });
  hpos = hist.length - 1;
  ui.search.value = '';
  render();
}
function go(d) {
  const n = hpos + d;
  if (n < 0 || n >= hist.length) return;
  hpos = n;
  ui.search.value = '';
  render();
}

function render() {
  const cur = hpos >= 0 ? hist[hpos] : { id: null };
  ui.back.disabled = hpos <= 0;
  ui.fwd.disabled = hpos >= hist.length - 1;
  const b = ui.body;
  b.replaceChildren();
  const t = cur.id && topics.get(cur.id);
  if (!t) { renderHome(b); b.scrollTop = 0; return; }
  b.append(mk('div', { class: 'ah-crumb' }, mk('button', { type: 'button', class: 'ah-link', 'data-nav': 'home', text: 'Contents' }), ` › ${t.section ?? ''}`));
  const art = mk('article', { class: 'ah-content help-content' });
  art.innerHTML = t.html; // trusted: compiled from our own help/ sources at build time
  const h1 = art.querySelector(':scope > h1:first-child');
  if (h1) h1.classList.add('ah-title'); else b.append(mk('h1', { class: 'ah-title', text: t.title }));
  const base = A.imgBase ?? new URL('./', import.meta.url).href;
  for (const img of art.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!/^(?:[a-z]+:|\/)/i.test(src)) img.src = new URL(src, base).href;
    img.loading = 'lazy';
  }
  b.append(art);
  const related = (D.sections.find((s) => s.title === t.section)?.topics ?? []).filter((x) => x !== t.id).slice(0, 6);
  if (related.length) {
    b.append(mk('div', { class: 'ah-related' }, mk('h2', { text: `More in ${t.section}` }),
      mk('ul', {}, related.map((rid) => mk('li', {}, mk('a', { href: `#topic:${rid}`, 'data-topic': rid, text: topics.get(rid)?.title ?? rid }))))));
  }
  const target = cur.anchor && art.querySelector(`#${CSS.escape(cur.anchor)}`);
  if (target) { target.scrollIntoView({ block: 'start' }); target.classList.add('ah-flash'); setTimeout(() => target.classList.remove('ah-flash'), 1600); } else b.scrollTop = 0;
}

function renderHome(b) {
  b.append(mk('h1', { class: 'ah-title', text: `${A.appName ?? ''} help`.trim() }),
    mk('p', { class: 'ah-lead', text: 'Search above, pick a topic, or take a guided tour. Press F1 over any control for its topic.' }));
  if (D.tours?.length) {
    b.append(mk('h2', { class: 'ah-sec', text: 'Guided tours' }),
      mk('ul', { class: 'ah-tours' }, D.tours.map((t) => mk('li', {}, mk('button', { type: 'button', class: 'ah-tourbtn', 'data-tour': t.id },
        mk('span', { class: 'ah-tt', text: t.title }), t.description ? mk('span', { class: 'ah-td', text: t.description }) : null)))));
  }
  for (const s of D.sections) {
    b.append(mk('h2', { class: 'ah-sec', text: s.title }),
      mk('ul', { class: 'ah-list' }, s.topics.map((id) => mk('li', {}, mk('a', { href: `#topic:${id}`, 'data-topic': id, text: topics.get(id)?.title ?? id })))));
  }
}

function showResults(q) {
  const b = ui.body;
  b.replaceChildren();
  const res = searchHelp(D.index, q, { limit: 25 });
  if (!res.length) { b.append(mk('p', { class: 'ah-none', text: `No topics match “${q.trim()}”.` })); return; }
  b.append(mk('ol', { class: 'ah-results', role: 'listbox', 'aria-label': 'Search results' }, res.map(({ id }) => {
    const t = topics.get(id);
    return mk('li', {}, mk('button', { type: 'button', class: 'ah-result', role: 'option', 'data-topic': id, onkeydown: resultKey },
      mk('span', { class: 'ah-rt', text: t?.title ?? id }), mk('span', { class: 'ah-rs', text: t?.section ?? '' })));
  })));
}
function resultKey(e) {
  const list = [...ui.body.querySelectorAll('.ah-result')];
  const i = list.indexOf(e.currentTarget);
  if (e.key === 'ArrowDown') { e.preventDefault(); list[Math.min(i + 1, list.length - 1)]?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) ui.search.focus(); else list[i - 1].focus(); }
}

function onBodyClick(e) {
  const a = e.target.closest('a, button');
  if (!a || !ui.body.contains(a)) return;
  if (a.dataset.nav === 'home') { e.preventDefault(); navigate(null); return; }
  if (a.dataset.tour) { e.preventDefault(); startTour(a.dataset.tour); return; }
  if (a.dataset.showme) { e.preventDefault(); showMe(a.dataset.showme); return; }
  if (a.dataset.topic) { e.preventDefault(); navigate(a.dataset.topic, a.dataset.anchor); return; }
  if (a.dataset.anchor) {
    e.preventDefault();
    ui.body.querySelector(`#${CSS.escape(a.dataset.anchor)}`)?.scrollIntoView({ block: 'start', behavior: smooth() });
    return;
  }
  if (a.dataset.ext || /^(https?:|mailto:)/i.test(a.getAttribute('href') ?? '')) { e.preventDefault(); A.openUrl?.(a.getAttribute('href')); }
}

function notice(text) {
  if (!panel || panel.hidden) { openHelp(); }
  unfold();
  const n = mk('div', { class: 'ah-notice', role: 'status', text });
  ui.body.prepend(n);
  setTimeout(() => n.remove(), 5000);
}

const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

// ---------------------------------------------------------------- targets
function visible(el) {
  if (!el?.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden) return false;
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  return true;
}

function lookup(id) {
  const t = A.targets?.[id] ?? D.targets?.[id];
  if (t == null) return undefined;
  try { return typeof t === 'function' ? t() : document.querySelector(t); } catch { return null; }
}

/** The element for a target id (bare ids also try tool:/btn:/panel:/el:…), after its prepare step; a visible stand-in when hidden. */
export async function resolveTarget(id) {
  if (!id) return null;
  const ids = PREFIXES.map((p) => (id.includes(':') && p ? null : p + id)).filter(Boolean);
  for (const k of ids) {
    const prep = A.prepare?.[k];
    if (prep) { try { await prep(); } catch { /* the control may stay hidden */ } }
    const el = lookup(k);
    if (el === undefined) continue;
    if (visible(el)) return el;
    const fb = A.fallback?.(k, el);
    if (visible(fb)) return fb;
    if (el) return null;
  }
  return null;
}

// ---------------------------------------------------------------- spotlight
function drawSpot(el, { caption, tourStep } = {}) {
  endSpot(true);
  const ring = mk('div', { class: `ah-spot${tourStep ? ' ah-spot-tour' : ''}`, 'aria-hidden': 'true' });
  const pop = mk('div', { class: 'ah-pop', role: tourStep ? 'dialog' : 'status', 'aria-live': 'polite' });
  if (caption) pop.append(caption);
  host().append(ring, pop);
  spot = { el, ring, pop, raf: 0, timer: 0 };
  const follow = () => {
    if (!spot) return;
    const r = el?.isConnected ? el.getBoundingClientRect() : null;
    if (r && r.width) {
      const pad = 4;
      Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px`, display: '' });
      placePop(pop, r, tourStep?.placement);
    } else {
      ring.style.display = 'none';
      Object.assign(pop.style, { left: `${Math.max(12, (innerWidth - pop.offsetWidth) / 2)}px`, top: `${Math.max(12, (innerHeight - pop.offsetHeight) / 2)}px` });
    }
    spot.raf = requestAnimationFrame(follow);
  };
  follow();
  return spot;
}

function placePop(pop, r, pref = 'auto') {
  const w = pop.offsetWidth, h = pop.offsetHeight, gap = 12, m = 8;
  const fits = { bottom: r.bottom + gap + h <= innerHeight - m, top: r.top - gap - h >= m, right: r.right + gap + w <= innerWidth - m, left: r.left - gap - w >= m };
  const order = [pref, 'bottom', 'top', 'right', 'left'].filter((p) => p && p !== 'auto');
  const side = order.find((p) => fits[p]) ?? 'bottom';
  let x, y;
  if (side === 'bottom' || side === 'top') { x = r.left + r.width / 2 - w / 2; y = side === 'bottom' ? r.bottom + gap : r.top - gap - h; } else { y = r.top + r.height / 2 - h / 2; x = side === 'right' ? r.right + gap : r.left - gap - w; }
  x = Math.min(Math.max(m, x), innerWidth - w - m);
  y = Math.min(Math.max(m, y), innerHeight - h - m);
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
  pop.dataset.side = side;
}

function endSpot(keepPanel = false) {
  if (!spot) return;
  cancelAnimationFrame(spot.raf);
  clearTimeout(spot.timer);
  spot.ring.remove();
  spot.pop.remove();
  const wasShowMe = !spot.tour;
  spot = null;
  if (!keepPanel && wasShowMe && panel && !panel.hidden) unfold();
}

/** Spotlight the control for targetId; the panel folds to a tab until the spotlight ends (click, Esc, 6 s). */
export async function showMe(targetId) {
  if (tour) endTour();
  const el = await resolveTarget(targetId);
  if (!el) { notice('That control is not visible right now. Open a document or widen the window, then try again.'); return false; }
  fold();
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim().slice(0, 40) || '';
  const s = drawSpot(el, { caption: mk('span', {}, mk('strong', { text: 'Here' }), label ? `: ${label.replace(/\s+/g, ' ')}` : '') });
  s.timer = setTimeout(() => endSpot(), 6000);
  return true;
}

function onPointerDown(e) {
  if (spot && !tour && !e.target.closest?.('.ash-help')) endSpot();
}

// ---------------------------------------------------------------- tours
export function startTour(id) {
  const t = D.tours?.find((x) => x.id === id);
  if (!t?.steps?.length) return false;
  endTour();
  if (panel) { panel.hidden = true; panel.classList.remove('ah-folded'); }
  tour = { t, i: 0 };
  showStep();
  return true;
}

export function endTour() {
  if (!tour) return;
  tour = null;
  endSpot(true);
}

async function showStep() {
  if (!tour) return;
  const { t, i } = tour;
  const st = t.steps[i];
  const el = await resolveTarget(st.target);
  if (!tour || tour.t !== t || tour.i !== i) return; // moved on while resolving
  const last = i === t.steps.length - 1;
  const how = st.advanceOn === 'click' ? 'Click the highlighted control to continue.' : st.advanceOn?.startsWith('event:') ? 'Do this step to continue, or press Next.' : '';
  const box = mk('div', { class: 'ah-step' },
    mk('div', { class: 'ah-step-n', text: `${t.title} · ${i + 1} / ${t.steps.length}` }),
    mk('h3', { text: st.title ?? '' }), mk('p', { text: st.text ?? '' }),
    !el ? mk('p', { class: 'ah-step-miss', text: '(This control is not visible right now.)' }) : null,
    how ? mk('p', { class: 'ah-step-how', text: how }) : null,
    mk('div', { class: 'ah-step-btns' },
      mk('button', { type: 'button', class: 'ah-btn', text: 'Skip tour', onclick: endTour }),
      i > 0 ? mk('button', { type: 'button', class: 'ah-btn', text: 'Back', onclick: () => step(-1) }) : null,
      mk('button', { type: 'button', class: 'ah-btn ah-primary', text: last ? 'Done' : 'Next', onclick: () => (last ? endTour() : step(1)) })));
  const s = drawSpot(el, { caption: box, tourStep: st });
  s.tour = true;
  box.querySelector('.ah-primary')?.focus({ preventScroll: true });
}

function step(d) {
  if (!tour) return;
  const n = tour.i + d;
  if (n < 0) return;
  if (n >= tour.t.steps.length) { endTour(); return; }
  tour.i = n;
  showStep();
}

/** The app reports something happened (e.g. 'tool:text', 'file:opened'): a tour step waiting for it moves on. */
export function helpEvent(name) {
  if (!tour) return;
  const st = tour.t.steps[tour.i];
  if (st?.advanceOn === `event:${name}`) setTimeout(() => step(1), 120);
}

function onTourClick(e) {
  if (!tour || !spot) return;
  const st = tour.t.steps[tour.i];
  if (st?.advanceOn === 'click' && spot.el?.contains?.(e.target)) setTimeout(() => step(1), 150);
}

// ---------------------------------------------------------------- welcome
export async function maybeWelcome(tourId = 'first-steps') {
  if (!A || !D.tours?.some((t) => t.id === tourId)) return false;
  let shown;
  try { shown = await A.getPref?.('help.welcomeShown'); } catch { shown = false; }
  if (shown) return false;
  const done = () => { card.remove(); try { A.setPref?.('help.welcomeShown', true); } catch { /* ignore */ } };
  const card = mk('div', { class: 'ah-welcome', role: 'dialog', 'aria-label': 'Welcome' },
    mk('strong', { text: `New to ${A.appName ?? 'the app'}?` }),
    mk('p', { text: 'Take a 1-minute tour of the basics. Help is always one key away: F1.' }),
    mk('div', { class: 'ah-step-btns' },
      mk('button', { type: 'button', class: 'ah-btn', 'data-welcome': 'no', text: 'Not now', onclick: done }),
      mk('button', { type: 'button', class: 'ah-btn ah-primary', 'data-welcome': 'yes', text: 'Take the tour', onclick: () => { done(); startTour(tourId); } })));
  host().append(card);
  return true;
}

// ---------------------------------------------------------------- context help
/** 'topic[/anchor]' for el from the nearest [data-help] (outside the help panel), or null. */
export function contextTopicAt(el) {
  const n = el?.closest?.('[data-help]');
  if (!n || n.closest('[data-ash-help]')) return null;
  return n.getAttribute('data-help') || null;
}

/** A small "?" button that opens topic[/anchor]. */
export function helpButton(ref) {
  const [id, anchor] = String(ref).split('/');
  return mk('button', { type: 'button', class: 'ah-q', title: 'Help (F1)', 'aria-label': 'Help for this', text: '?', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openHelp(id, anchor); } });
}

function contextRef() {
  const under = mouse.x >= 0 ? document.elementFromPoint(mouse.x, mouse.y) : null;
  const a = under && !under.closest('[data-ash-help]') ? (contextTopicAt(under) ?? A.contextOf?.(under) ?? null) : null;
  if (a) return a;
  const dlgs = [...document.querySelectorAll('[role="dialog"][data-help], dialog[open][data-help]')].filter((d) => !d.closest('[data-ash-help]') && visible(d));
  if (dlgs.length) return dlgs[dlgs.length - 1].getAttribute('data-help');
  const f = document.activeElement && contextTopicAt(document.activeElement);
  return f || null;
}

function onKey(e) {
  if (e.key === 'F1' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    const ref = contextRef();
    const [id, anchor] = ref ? ref.split('/') : [A.home ?? 'welcome'];
    openHelp(topics.has(id) ? id : (topics.has(A.home ?? 'welcome') ? (A.home ?? 'welcome') : undefined), anchor);
    return;
  }
  if (e.key !== 'Escape') return;
  if (tour) { e.preventDefault(); e.stopPropagation(); endTour(); return; }
  if (spot) { e.preventDefault(); e.stopPropagation(); endSpot(); return; }
  const card = document.querySelector('.ah-welcome');
  if (card && card.contains(document.activeElement)) { e.preventDefault(); e.stopPropagation(); card.querySelector('[data-welcome="no"]')?.click(); return; }
  if (panel && !panel.hidden && panel.contains(document.activeElement)) {
    e.preventDefault();
    e.stopPropagation();
    if (ui.search.value) { ui.search.value = ''; render(); ui.search.focus(); } else closeHelp();
  }
}
