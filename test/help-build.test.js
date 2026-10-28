// Help build pipeline (scripts/build-help.mjs) and search ranking (renderer/help/help-search.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileHelp, parseTopic, renderMarkdown, siteHtml, writeSite, escapeHtml, describe } from '../scripts/build-help.mjs';
import { indexEntry, searchHelp } from '../renderer/help/help-search.js';

const topic = (id, title, section, order, body, keywords = '') => `---\nid: ${id}\ntitle: ${title}\nsection: ${section}\norder: ${order}\nkeywords: ${keywords}\n---\n${body}\n`;

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'help-test-'));
  await mkdir(join(dir, 'topics'));
  await mkdir(join(dir, 'tours'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

test('compileHelp: topics with ids, sections grouped by topic order, index and tours', async () => {
  const dir = await fixture({
    'topics/b.md': topic('b-topic', 'Bee', 'Editing', 10, 'See [A](#topic:a-topic/sub).'),
    'topics/a.md': topic('a-topic', 'Aye', 'Basics', 1, '## Sub heading\nText [Show me](#showme:text)', 'alpha, first'),
    'topics/c.md': topic('c-topic', 'Cee', 'Basics', 2, 'Plain'),
    'tours/t.json': JSON.stringify({ id: 'tour-one', title: 'Tour', steps: [{ target: 'open', title: 'S1', text: 'x', advanceOn: 'event:tool:text' }] }),
  });
  try {
    const d = await compileHelp(dir);
    assert.deepEqual(d.topics.map((t) => t.id), ['a-topic', 'c-topic', 'b-topic']);
    assert.deepEqual(d.sections, [{ id: 'basics', title: 'Basics', topics: ['a-topic', 'c-topic'] }, { id: 'editing', title: 'Editing', topics: ['b-topic'] }]);
    assert.deepEqual(d.topics[0].keywords, ['alpha', 'first']);
    assert.match(d.topics[0].html, /<h2 id="sub-heading">Sub heading<\/h2>/);
    assert.match(d.topics[0].html, /<a href="#showme:text" class="help-showme" data-showme="text"/);
    assert.match(d.topics[2].html, /data-topic="a-topic" data-anchor="sub"/);
    assert.equal(d.topics[0].text.includes('<'), false);
    assert.deepEqual(d.index.map((e) => e.id), ['a-topic', 'c-topic', 'b-topic']);
    assert.deepEqual(d.tours[0].steps[0], { target: 'open', title: 'S1', text: 'x', placement: 'auto', advanceOn: 'event:tool:text' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('compileHelp: a link to an unknown topic, a bad id or a bad advanceOn fails the build', async () => {
  for (const files of [
    { 'topics/a.md': topic('a', 'A', 'S', 1, '[x](#topic:nope)') },
    { 'topics/a.md': topic('Bad Id', 'A', 'S', 1, 'x') },
    { 'topics/a.md': topic('a', 'A', 'S', 1, 'x'), 'tours/t.json': JSON.stringify({ id: 't', title: 'T', steps: [{ title: 'a', text: 'b', advanceOn: 'later' }] }) },
    { 'topics/a.md': topic('a', 'A', 'S', 1, '![x](../secret.png)') },
  ]) {
    const dir = await fixture(files);
    try { await assert.rejects(compileHelp(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('callouts, tables, kbd and images render', () => {
  const html = renderMarkdown('> [!TIP]\n> Press <kbd>F1</kbd>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![Alt "q"](img/x.png)');
  assert.match(html, /<div class="help-callout help-tip" role="note"><p class="help-callout-title">Tip<\/p><p>Press <kbd>F1<\/kbd>/);
  assert.match(html, /<table>/);
  assert.match(html, /<img src="img\/x.png" alt="Alt &quot;q&quot;"/);
});

test('writer callouts: a blockquote starting **Note:** / **Tip:** / **Important:** / **Warning:** is a callout', () => {
  for (const [label, kind] of [['Note', 'note'], ['Tip', 'tip'], ['Important', 'important'], ['Warning', 'warning']]) {
    const html = renderMarkdown(`> **${label}:** Press <kbd>F1</kbd> here.`);
    assert.match(html, new RegExp(`^<div class="help-callout help-${kind}" role="note"><p class="help-callout-title">${label}</p><p>Press <kbd>F1</kbd> here.</p>\\n</div>`), label);
    assert.doesNotMatch(html, /<strong>|<blockquote>/, label);
  }
  // label alone on the first line, more paragraphs after it
  assert.match(renderMarkdown('> **Tip:**\n>\n> One.\n>\n> Two.'), /<p class="help-callout-title">Tip<\/p><p>One.<\/p>\n<p>Two.<\/p>\n<\/div>/);
  // bold text that is not a callout label, or a label later in the quote, stays a blockquote
  assert.match(renderMarkdown('> **Bold:** quote'), /^<blockquote>/);
  assert.match(renderMarkdown('> Text **Note:** x'), /^<blockquote>/);
});

test('compileHelp: missing images warn (build succeeds); targets and context maps are merged and checked', async () => {
  const dir = await fixture({
    'topics/a.md': topic('a', 'A', 'S', 1, '![x](img/there.png) ![y](img/gone.png) [Show](#showme:tool:text)'),
    'targets.json': JSON.stringify({ open: '#btn-open', viewer: '.viewer-host' }),
    'targets-b.json': JSON.stringify({ viewer: 'main.viewer-host', thumbs: '#sb-tab-thumbs' }),
    'context.json': JSON.stringify({ '.toolbar': 'a', 'dialog:Print': 'a/sub' }),
  });
  try {
    await mkdir(join(dir, 'img'));
    await writeFile(join(dir, 'img', 'there.png'), '');
    const d = await compileHelp(dir);
    assert.deepEqual(d.warnings, ['a: image img/gone.png is missing from help/img']);
    assert.deepEqual(d.targets, { open: '#btn-open', viewer: 'main.viewer-host', thumbs: '#sb-tab-thumbs' }, 'targets-b.json wins on a clash');
    assert.deepEqual(d.context, { '.toolbar': 'a', 'dialog:Print': 'a/sub' });
    assert.match(d.topics[0].html, /data-showme="tool:text"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
  const none = await fixture({ 'topics/a.md': topic('a', 'A', 'S', 1, 'x') });
  try { const d = await compileHelp(none); assert.deepEqual([d.targets, d.context, d.warnings], [{}, {}, []]); } finally { await rm(none, { recursive: true, force: true }); }
  for (const files of [{ 'context-b.json': JSON.stringify({ '.x': 'nope' }) }, { 'targets.json': JSON.stringify({ open: 3 }) }, { 'targets.json': '[]' }]) {
    const bad = await fixture({ 'topics/a.md': topic('a', 'A', 'S', 1, 'x'), ...files });
    try { await assert.rejects(compileHelp(bad)); } finally { await rm(bad, { recursive: true, force: true }); }
  }
});

test('buildHelp emits targets and context into help-data.js', async () => {
  const dir = await fixture({ 'topics/a.md': topic('a', 'A', 'S', 1, 'x'), 'targets.json': '{"open":"#btn-open"}', 'context.json': '{".bar":"a"}' });
  try {
    const { buildHelp } = await import('../scripts/build-help.mjs');
    const dataFile = join(dir, 'out', 'help-data.js');
    await buildHelp({ srcDir: dir, dataFile, siteDir: join(dir, 'site') });
    const { default: data } = await import(`file://${dataFile}`);
    assert.deepEqual([data.targets, data.context], [{ open: '#btn-open' }, { '.bar': 'a' }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('website output rewrites topic links to pages and Show-me links to a note', () => {
  const html = renderMarkdown('[A](#topic:a-topic/sub) [B](#topic:b) [Show me](#showme:text) [W](https://ashpmcs.com)');
  const site = siteHtml(html);
  assert.match(site, /<a href="a-topic.html#sub">A<\/a>/);
  assert.match(site, /<a href="b.html">B<\/a>/);
  assert.match(site, /<span class="help-inapp"[^>]*>In the app: Help ▸ Show me<\/span>/);
  assert.doesNotMatch(site, /#showme:|#topic:/);
  assert.match(site, /href="https:\/\/ashpmcs.com" class="help-ext" target="_blank" rel="noopener"/);
});

test('front-matter values are escaped in the website pages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-site-'));
  try {
    const t = parseTopic(topic('x', '<script>"T"</script>', 'S & <b>', 1, 'Body'));
    const data = { sections: [{ id: 's', title: t.section, topics: ['x'] }], topics: [{ id: 'x', title: t.title, html: '<p>Body</p>' }], tours: [], index: [] };
    await writeSite(data, dir);
    const page = await readFile(join(dir, 'x.html'), 'utf8');
    assert.doesNotMatch(page, /<script>"T"/);
    assert.match(page, /&lt;script&gt;&quot;T&quot;&lt;\/script&gt;/);
    assert.match(page, /S &amp; &lt;b&gt;/);
    assert.match(page, /https:\/\/ashdesignsuite.com/);
    assert.match(page, /href="#download"/);
    assert.equal(escapeHtml(`a"'<>&`), 'a&quot;&#39;&lt;&gt;&amp;');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('help/site.json gives the website pages a description, canonical, download link and sitemap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'help-site-'));
  try {
    const data = { sections: [{ id: 's', title: 'S', topics: ['x'] }], topics: [{ id: 'x', title: 'X', html: '<h1>X</h1><p>First <strong>para</strong> &amp; more, long enough for a lead.</p><p>Second.</p>' }],
      tours: [{ id: 't', title: 'T', description: 'Tour "one"', steps: [] }], index: [] };
    const site = { baseUrl: 'https://example.com/help/app/', downloadUrl: 'https://example.com/studio/#app', homeTitle: 'User guide', description: 'Home description' };
    await writeSite(data, dir, { site });
    const [home, x, tour, map] = await Promise.all(['index.html', 'x.html', 'tour-t.html', 'sitemap.xml'].map((f) => readFile(join(dir, f), 'utf8')));
    assert.match(home, /<title>User guide — /);
    assert.match(home, /<meta name="description" content="Home description">/);
    assert.match(home, /<link rel="canonical" href="https:\/\/example.com\/help\/app\/">/);
    assert.match(x, /<meta name="description" content="First para &amp; more, long enough for a lead.">/);
    assert.match(x, /<link rel="canonical" href="https:\/\/example.com\/help\/app\/x">/);
    assert.match(x, /class="hs-dl" href="https:\/\/example.com\/studio\/#app"/);
    assert.match(tour, /<meta name="description" content="Tour &quot;one&quot;">/);
    assert.match(map, /<loc>https:\/\/example.com\/help\/app\/<\/loc>[\s\S]*<loc>https:\/\/example.com\/help\/app\/x<\/loc>[\s\S]*<loc>https:\/\/example.com\/help\/app\/tour-t<\/loc>/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('describe uses the first real paragraph, cut at a sentence or word end, else the title and headings', () => {
  assert.equal(describe('<p>Short but long enough to be a real lead paragraph.</p>'), 'Short but long enough to be a real lead paragraph.');
  const long = `<p>${'One two three four five six seven eight nine ten. '.repeat(3)}${'word '.repeat(40)}</p>`;
  assert.equal(describe(long), 'One two three four five six seven eight nine ten. '.repeat(3).trim());
  const words = describe(`<p>${'alpha beta, '.repeat(30)}</p>`);
  assert.ok(words.length <= 156 && words.endsWith('…') && !/,…$/.test(words), words);
  const callout = '<div class="help-callout help-tip" role="note"><p class="help-callout-title">Tip</p><p>A tip that is long enough to be picked by mistake.</p></div>';
  const showme = '<p><a href="#showme:x" class="help-showme" data-showme="x" role="button">Show me the Hatch button</a></p>';
  assert.equal(describe(`${callout}${showme}<p>Other ways to open:</p><p>The real lead paragraph of this topic, &amp; more.</p>`), 'The real lead paragraph of this topic, & more.');
  assert.equal(describe('<h1>M</h1><h2>Merge PDFs</h2><ol><li>x</li></ol><h2>Split a PDF</h2>', { title: 'Merge and split', appName: 'App' }), 'Merge and split in App: merge PDFs, split a PDF.');
  assert.equal(describe('<p>Each open drawing has a tab above the drawing area. <a href="#showme:t" class="help-showme" data-showme="t" role="button">Show me</a> the tab bar.</p>'), 'Each open drawing has a tab above the drawing area.');
  assert.equal(describe('<h1>T</h1><h2>Steps</h2><p>A paragraph deep in the topic, not its lead paragraph.</p>', { title: 'T', appName: 'App' }), 'T in App: steps.');
  assert.equal(describe('<h2>PAN</h2><h2>Ctrl keys</h2><h2>Wheel speed</h2>', { title: 'Zoom', appName: 'App' }), 'Zoom in App: PAN, Ctrl keys, wheel speed.');
  assert.equal(describe('<ul><li>no paragraph</li></ul>'), '');
});

test('searchHelp ranks title over keyword over body text', () => {
  const index = [
    indexEntry({ id: 'body', title: 'Other', keywords: [], text: 'about a text box here' }),
    indexEntry({ id: 'kw', title: 'Something', keywords: ['text box'], text: '' }),
    indexEntry({ id: 'title', title: 'Add a text box', keywords: [], text: '' }),
    indexEntry({ id: 'none', title: 'Print', keywords: ['paper'], text: 'printer' }),
  ];
  assert.deepEqual(searchHelp(index, 'text box').map((r) => r.id), ['title', 'kw', 'body']);
  assert.deepEqual(searchHelp(index, 'prin').map((r) => r.id), ['none'], 'prefix match');
  assert.deepEqual(searchHelp(index, '  '), []);
});
