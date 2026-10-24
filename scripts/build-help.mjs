#!/usr/bin/env node
// Compiles help/ (topics/*.md, tours/*.json, img/) into
//   renderer/help/help-data.js  ES module {sections, topics, tours, index} for the in-app engine (committed)
//   renderer/help/img/          the topic images
//   help-site/                  static website: index.html + <topic-id>.html, search, tours (gitignored)
// Markdown is turned into HTML here (marked, a devDependency): the app has no Markdown dependency.
//   node scripts/build-help.mjs        (npm run help:build)
// Topic conventions (see the front-matter / link / callout rules in parseTopic and renderMarkdown).
import { readFile, writeFile, readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Marked } from 'marked';
import { indexEntry } from '../renderer/help/help-search.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const ID = /^[a-z0-9][a-z0-9-]*$/;
const CALLOUTS = { NOTE: 'Note', TIP: 'Tip', WARNING: 'Warning', IMPORTANT: 'Important' };

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const slug = (s) => String(s).toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** '---\nkey: value\n---\nbody' → {meta, body}. keywords: comma list or [a, b]. */
export function parseTopic(src, file = 'topic') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error(`${file}: missing front-matter (--- id/title/section/order/keywords ---)`);
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  if (!ID.test(meta.id ?? '')) throw new Error(`${file}: id must be lower-case letters, digits and dashes (got "${meta.id ?? ''}")`);
  if (!meta.title) throw new Error(`${file}: title is required`);
  return {
    id: meta.id,
    title: meta.title,
    section: meta.section || 'General',
    order: Number(meta.order) || 0,
    keywords: (meta.keywords ?? '').replace(/^\[|\]$/g, '').split(',').map((k) => k.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean),
    body: m[2],
  };
}

/** Markdown → in-app HTML. Links: #topic:<id>[/<anchor>], #showme:<targetId>, http(s)/mailto (external). */
export function renderMarkdown(md) {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${slug(inner)}">${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        let m;
        if ((m = /^#topic:([a-z0-9-]+)(?:\/([\w-]+))?$/.exec(href))) return `<a href="#topic:${m[1]}${m[2] ? `/${m[2]}` : ''}" data-topic="${m[1]}"${m[2] ? ` data-anchor="${m[2]}"` : ''}${t}>${inner}</a>`;
        if ((m = /^#showme:([\w:.-]+)$/.exec(href))) return `<a href="#showme:${m[1]}" class="help-showme" data-showme="${m[1]}" role="button"${t}>${inner}</a>`;
        if (/^(https?:|mailto:)/i.test(href)) return `<a href="${escapeHtml(href)}" class="help-ext" data-ext="1"${t}>${inner}</a>`;
        if (/^#[\w-]+$/.test(href)) return `<a href="${href}" data-anchor="${href.slice(1)}"${t}>${inner}</a>`;
        throw new Error(`unsupported link "${href}" (use #topic:<id>, #showme:<target>, #<anchor> or http(s)://)`);
      },
      image({ href, title, text }) {
        if (!/^img\/[\w.-]+\.(png|jpe?g|svg|webp)$/i.test(href)) throw new Error(`image "${href}": use img/<name>.png`);
        return `<img src="${href}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
      },
      blockquote({ tokens }) {
        const body = this.parser.parse(tokens);
        // > [!NOTE] … or the writers' form > **Note:** … (label stripped, used as the title)
        const m = /^<p>\[!(\w+)\]\s*/.exec(body) ?? /^<p><strong>(\w+):<\/strong>\s*/.exec(body);
        if (m && CALLOUTS[m[1].toUpperCase()]) {
          const kind = m[1].toLowerCase();
          const rest = body.slice(m[0].length);
          const alone = /^<\/p>\s*/.exec(rest); // the label had its own paragraph: the rest is whole blocks
          return `<div class="help-callout help-${kind}" role="note"><p class="help-callout-title">${CALLOUTS[m[1].toUpperCase()]}</p>${alone ? rest.slice(alone[0].length) : `<p>${rest}`}</div>\n`;
        }
        return `<blockquote>${body}</blockquote>\n`;
      },
    },
  });
  return marked.parse(md);
}

const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** In-app HTML → website HTML: topic links become page links, Show-me links a note. */
export function siteHtml(html) {
  return html
    .replace(/<a href="#topic:([a-z0-9-]+)(?:\/([\w-]+))?" data-topic="[^"]*"(?: data-anchor="[^"]*")?/g, (_, id, a) => `<a href="${id}.html${a ? `#${a}` : ''}"`)
    .replace(/<a href="#showme:[\w:.-]+" class="help-showme"[^>]*>([\s\S]*?)<\/a>/g, (_, inner) => `<span class="help-inapp" title="${escapeHtml(inner.replace(/<[^>]*>/g, ''))}">In the app: Help ▸ Show me</span>`)
    .replace(/ class="help-ext" data-ext="1"/g, ' class="help-ext" target="_blank" rel="noopener"');
}

function checkTour(t, file) {
  if (!ID.test(t?.id ?? '')) throw new Error(`${file}: tour id must be lower-case letters, digits and dashes`);
  if (!t.title || !Array.isArray(t.steps) || !t.steps.length) throw new Error(`${file}: title and steps[] are required`);
  for (const [i, s] of t.steps.entries()) {
    if (!s.title || !s.text) throw new Error(`${file}: step ${i + 1} needs title and text`);
    if (s.advanceOn && !/^(next|click|event:[\w:.-]+)$/.test(s.advanceOn)) throw new Error(`${file}: step ${i + 1} advanceOn must be next, click or event:<name>`);
    if (s.placement && !/^(auto|top|bottom|left|right)$/.test(s.placement)) throw new Error(`${file}: step ${i + 1} placement must be auto|top|bottom|left|right`);
  }
  return { id: t.id, title: t.title, description: t.description ?? '', steps: t.steps.map((s) => ({ target: s.target ?? null, title: s.title, text: s.text, placement: s.placement ?? 'auto', advanceOn: s.advanceOn ?? 'next' })) };
}

/**
 * Read help/ → {sections, topics, tours, index, targets, context, warnings}. Throws on any broken topic,
 * link, tour or map entry. targets: help/targets.json + targets-b.json ({showMeId: selector});
 * context: help/context.json + context-b.json ({selector | "dialog:<Title>": "topic[/anchor]"}).
 * warnings: images referenced but missing from help/img (the build still succeeds).
 */
export async function compileHelp(srcDir = join(ROOT, 'help')) {
  const files = (await readdir(join(srcDir, 'topics'))).filter((f) => f.endsWith('.md')).sort();
  const topics = [];
  for (const f of files) {
    const t = parseTopic(await readFile(join(srcDir, 'topics', f), 'utf8'), f);
    if (topics.some((o) => o.id === t.id)) throw new Error(`${f}: duplicate topic id ${t.id}`);
    let html;
    try { html = renderMarkdown(t.body); } catch (err) { throw new Error(`${f}: ${err.message}`); }
    topics.push({ id: t.id, title: t.title, section: t.section, order: t.order, keywords: t.keywords, html, text: textOf(html) });
  }
  for (const t of topics) for (const [, id] of t.html.matchAll(/data-topic="([^"]+)"/g)) if (!topics.some((o) => o.id === id)) throw new Error(`${t.id}: link to unknown topic ${id}`);
  topics.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  const sections = [];
  for (const t of topics) {
    let s = sections.find((x) => x.title === t.section);
    if (!s) sections.push(s = { id: slug(t.section), title: t.section, topics: [] });
    s.topics.push(t.id);
  }
  const tourDir = join(srcDir, 'tours');
  const tours = [];
  for (const f of existsSync(tourDir) ? (await readdir(tourDir)).filter((x) => x.endsWith('.json')).sort() : []) tours.push(checkTour(JSON.parse(await readFile(join(tourDir, f), 'utf8')), f));
  const warnings = [];
  for (const t of topics) for (const [, name] of t.html.matchAll(/<img src="img\/([^"]+)"/g)) if (!existsSync(join(srcDir, 'img', name))) warnings.push(`${t.id}: image img/${name} is missing from help/img`);
  const mapFiles = (prefix) => (existsSync(srcDir) ? readdirSync(srcDir) : []).filter((f) => f === `${prefix}.json` || (f.startsWith(`${prefix}-`) && f.endsWith('.json'))).sort((a, b) => (a === `${prefix}.json` ? -1 : b === `${prefix}.json` ? 1 : a.localeCompare(b)));
  // Writers' target files may hold {selector, source} objects: keep the selector.
  const targets = await readMaps(srcDir, mapFiles('targets'), (k, v, f) => {
    const sel = typeof v === 'string' ? v : v?.selector;
    if (typeof sel !== 'string' || !sel.trim()) throw new Error(`${f}: target "${k}" must map to a CSS selector string or {selector}`);
  }, (v) => (typeof v === 'string' ? v : v.selector));
  const context = await readMaps(srcDir, mapFiles('context'), (k, v, f) => {
    const id = typeof v === 'string' ? v.split('/')[0] : '';
    if (!topics.some((o) => o.id === id)) throw new Error(`${f}: "${k}" maps to unknown topic ${v}`);
  });
  return { sections, topics, tours, index: topics.map(indexEntry), targets, context, warnings };
}

/** Merge the {key: value} JSON files that exist in srcDir (later files win); check(key, value, file) throws on a bad entry. */
export async function readMaps(srcDir, names, check, map = (x) => x) {
  const out = {};
  for (const f of names) {
    if (!existsSync(join(srcDir, f))) continue;
    const v = JSON.parse(await readFile(join(srcDir, f), 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${f}: must be a JSON object`);
    for (const [k, x] of Object.entries(v)) { check(k, x, f); out[k] = map(x); }
  }
  return out;
}

const page = ({ title, body, nav, appName }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(appName)} Help</title><link rel="stylesheet" href="site.css"></head>
<body class="help-site"><header class="hs-head"><a class="hs-brand" href="index.html">${escapeHtml(appName)} Help</a>
<nav class="hs-links"><a href="https://ashdesignsuite.com">ASH Design Suite</a><a href="https://ashpmcs.com">ASH PMCS</a><a class="hs-dl" href="#download">Download</a></nav></header>
<div class="hs-main"><aside class="hs-side"><input type="search" id="hs-q" placeholder="Search help" aria-label="Search help"><ol id="hs-results" hidden></ol>${nav}</aside>
<main class="hs-content help-content">${body}</main></div><script type="module" src="site.js"></script></body></html>
`;

const SITE_CSS = `body{margin:0;font:15px/1.55 system-ui,Segoe UI,sans-serif;background:#f6f2e8;color:#1f2a24}a{color:#1f4d3a}
.hs-head{display:flex;align-items:center;gap:24px;padding:12px 24px;background:#1f4d3a;color:#f6f2e8;border-bottom:3px solid #b08d3c}
.hs-head a{color:#f6f2e8;text-decoration:none}.hs-brand{font-weight:600;font-size:18px}.hs-links{margin-left:auto;display:flex;gap:18px}.hs-dl{color:#e7c873!important}
.hs-main{display:flex;max-width:1100px;margin:0 auto}.hs-side{width:260px;padding:20px;border-right:1px solid #d9d1bd}.hs-side ul{list-style:none;padding-left:0}
.hs-side h3{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#6b6250;margin:18px 0 6px}.hs-side li{margin:4px 0}.hs-side a[aria-current]{font-weight:600}
#hs-q{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #cfc5ab;border-radius:6px}.hs-content{flex:1;padding:24px 36px;min-width:0}
.hs-content img{max-width:100%;border:1px solid #d9d1bd;border-radius:6px}.help-callout{border-left:4px solid #b08d3c;background:#fffaf0;padding:8px 14px;margin:12px 0;border-radius:4px}
.help-callout-title{font-weight:600;margin:0 0 4px}.help-warning{border-color:#a8442f}.help-inapp{font-size:13px;background:#e8e1cf;padding:2px 8px;border-radius:10px}
kbd{font:12px ui-monospace,monospace;border:1px solid #bfb59c;border-bottom-width:2px;border-radius:4px;padding:1px 5px;background:#fff}
table{border-collapse:collapse}th,td{border:1px solid #d9d1bd;padding:5px 10px;text-align:left}ol.hs-tour li{margin:10px 0}`;

const SITE_JS = (idx, titles) => `import { searchHelp } from './help-search.js';
const index = ${JSON.stringify(idx)}, titles = ${JSON.stringify(titles)};
const q = document.getElementById('hs-q'), out = document.getElementById('hs-results');
q.addEventListener('input', () => {
  const r = searchHelp(index, q.value, { limit: 10 });
  out.hidden = !q.value.trim();
  out.replaceChildren(...r.map(({ id }) => { const li = document.createElement('li'), a = document.createElement('a'); a.href = id + '.html'; a.textContent = titles[id]; li.append(a); return li; }));
});
`;

/** Write the website for compiled help into outDir. */
export async function writeSite(data, outDir, { appName = productName(), imgDir } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const nav = (current) => data.sections.map((s) => `<h3>${escapeHtml(s.title)}</h3><ul>${s.topics.map((id) => `<li><a href="${id}.html"${id === current ? ' aria-current="page"' : ''}>${escapeHtml(data.topics.find((t) => t.id === id).title)}</a></li>`).join('')}</ul>`).join('')
    + (data.tours.length ? `<h3>Guided tours</h3><ul>${data.tours.map((t) => `<li><a href="tour-${t.id}.html"${`tour-${t.id}` === current ? ' aria-current="page"' : ''}>${escapeHtml(t.title)}</a></li>`).join('')}</ul>` : '');
  const home = `<h1>${escapeHtml(appName)} Help</h1>${data.sections.map((s) => `<h2>${escapeHtml(s.title)}</h2><ul>${s.topics.map((id) => `<li><a href="${id}.html">${escapeHtml(data.topics.find((t) => t.id === id).title)}</a></li>`).join('')}</ul>`).join('')}`;
  await writeFile(join(outDir, 'index.html'), page({ title: 'Home', body: home, nav: nav(''), appName }));
  for (const t of data.topics) await writeFile(join(outDir, `${t.id}.html`), page({ title: t.title, body: `${/^\s*<h1[\s>]/.test(t.html) ? '' : `<h1>${escapeHtml(t.title)}</h1>`}${siteHtml(t.html)}`, nav: nav(t.id), appName }));
  for (const t of data.tours) {
    const body = `<h1>${escapeHtml(t.title)}</h1><p>${escapeHtml(t.description)}</p><p class="help-inapp">In the app: Help ▸ Guided tours</p><ol class="hs-tour">${t.steps.map((s) => `<li><strong>${escapeHtml(s.title)}</strong><br>${escapeHtml(s.text)}</li>`).join('')}</ol>`;
    await writeFile(join(outDir, `tour-${t.id}.html`), page({ title: t.title, body, nav: nav(`tour-${t.id}`), appName }));
  }
  await writeFile(join(outDir, 'site.css'), SITE_CSS);
  await copyFile(join(ROOT, 'renderer', 'help', 'help-search.js'), join(outDir, 'help-search.js'));
  await writeFile(join(outDir, 'site.js'), SITE_JS(data.index, Object.fromEntries(data.topics.map((t) => [t.id, t.title]))));
  if (imgDir) await copyImages(imgDir, join(outDir, 'img'));
}

/** The app's name from package.json (productName), for the website header. */
function productName() {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).productName ?? 'ASH'; } catch { return 'ASH'; }
}

async function copyImages(from, to) {
  if (!existsSync(from)) return;
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  for (const f of await readdir(from)) if (/\.(png|jpe?g|svg|webp)$/i.test(f)) await copyFile(join(from, f), join(to, f));
}

export async function buildHelp({ srcDir = join(ROOT, 'help'), dataFile = join(ROOT, 'renderer', 'help', 'help-data.js'), siteDir = join(ROOT, 'help-site') } = {}) {
  const data = await compileHelp(srcDir);
  for (const w of data.warnings) console.warn(`help: warning: ${w}`);
  const out = { sections: data.sections, topics: data.topics.map(({ order: _o, ...t }) => t), tours: data.tours, index: data.index, targets: data.targets, context: data.context };
  await mkdir(resolve(dataFile, '..'), { recursive: true });
  await writeFile(dataFile, `// Generated by scripts/build-help.mjs from help/ — do not edit; run npm run help:build.\nexport default ${JSON.stringify(out, null, 1)};\n`);
  await copyImages(join(srcDir, 'img'), join(resolve(dataFile, '..'), 'img'));
  await writeSite(out, siteDir, { imgDir: join(srcDir, 'img') });
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const d = await buildHelp();
  console.log(`help: ${d.topics.length} topics, ${d.tours.length} tours → renderer/help/help-data.js, help-site/`);
}
