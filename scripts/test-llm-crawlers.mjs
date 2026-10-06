#!/usr/bin/env node
/* ==========================================================================
   test-llm-crawlers.mjs — runs the edge function locally, against the real
   pages in this repo, with a stand-in for Netlify's context object.

   No Deno, no Netlify CLI, no network. Node's built-in Request/Response/
   Headers are the same web standards the edge runtime uses, so the function
   file is imported unchanged.

       node scripts/test-llm-crawlers.mjs

   Exits non-zero on the first failed check.
   ========================================================================== */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import handler, { prefersMarkdown } from '../netlify/edge-functions/llm-crawlers.js';
import { identifyAiCrawler, AI_CRAWLERS } from '../netlify/lib/ai-crawlers.js';
import { htmlToMarkdown } from '../netlify/lib/html-to-markdown.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://infinityreachmedia.com';

/* ---------- a tiny static Netlify ---------- */

function serve(pathname) {
  // Mirrors Netlify's pretty URLs: /about -> about.html, / -> index.html.
  let file = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (!/\.[a-z0-9]+$/i.test(file)) file += '.html';
  const full = join(root, file);
  if (!existsSync(full)) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const type = file.endsWith('.html') ? 'text/html; charset=UTF-8'
    : file.endsWith('.txt') ? 'text/plain; charset=UTF-8' : 'application/octet-stream';
  return new Response(readFileSync(full), {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'public,max-age=0,must-revalidate' },
  });
}

function run(path, { ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128 Safari/537.36', accept = 'text/html,application/xhtml+xml,*/*;q=0.8', method = 'GET' } = {}) {
  const url = new URL(path, SITE);
  const request = new Request(url, { method, headers: { 'user-agent': ua, accept } });
  const logs = [];
  const context = {
    log: (...args) => logs.push(args.join(' ')),
    next: async () => serve(url.pathname),
    rewrite: async (target) => serve(new URL(target, SITE).pathname),
  };
  return handler(request, context).then((response) => ({ response, logs }));
}

const GPTBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const CLAUDEBOT = 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';

let checks = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { checks++; console.log(`  ok  ${name}`); })
    .catch((err) => { console.error(`FAIL  ${name}\n      ${err.message}`); process.exit(1); });
}

/* ---------- the checks ---------- */

await check('crawler registry matches every crawler named in robots.txt', () => {
  const robots = readFileSync(join(root, 'robots.txt'), 'utf8');
  const named = [...robots.matchAll(/^User-agent:\s*(\S+)/gm)].map((m) => m[1]).filter((n) => n !== '*');
  for (const name of named) {
    const hit = identifyAiCrawler(`Mozilla/5.0 (compatible; ${name}/1.0)`);
    assert.ok(hit, `robots.txt names ${name} but ai-crawlers.js does not recognise it`);
  }
  assert.equal(identifyAiCrawler('Mozilla/5.0 (Macintosh) Safari/605.1.15'), null, 'a browser is not a crawler');
  assert.equal(identifyAiCrawler(GPTBOT).name, 'GPTBot');
  assert.equal(identifyAiCrawler('Mozilla/5.0 (compatible; Applebot-Extended/1.0)').name, 'Applebot-Extended');
  assert.ok(AI_CRAWLERS.length >= named.length);
});

await check('Accept negotiation: browsers never get Markdown, agents asking for it do', () => {
  assert.equal(prefersMarkdown('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'), false);
  assert.equal(prefersMarkdown('*/*'), false);
  assert.equal(prefersMarkdown(null), false);
  assert.equal(prefersMarkdown('text/markdown'), true);
  assert.equal(prefersMarkdown('text/markdown, text/html;q=0.8'), true);
  assert.equal(prefersMarkdown('text/html, text/markdown;q=0.5'), false);
  assert.equal(prefersMarkdown('text/markdown;q=0'), false);
});

await check('browser visit to /about passes through as HTML with alternate links', async () => {
  const { response, logs } = await run('/about');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const body = await response.text();
  assert.equal(body, readFileSync(join(root, 'about.html'), 'utf8'), 'HTML body must be byte-for-byte the original');
  assert.match(response.headers.get('link'), /<https:\/\/infinityreachmedia\.com\/about\.md>; rel="alternate"; type="text\/markdown"/);
  assert.match(response.headers.get('link'), /llms\.txt/);
  assert.match(response.headers.get('vary'), /Accept/);
  assert.equal(response.headers.get('x-irm-crawler'), null);
  assert.equal(logs.length, 0, 'browsers are not logged');
});

await check('homepage alternate points at /index.md', async () => {
  const { response } = await run('/');
  assert.match(response.headers.get('link'), /<https:\/\/infinityreachmedia\.com\/index\.md>; rel="alternate"; type="text\/markdown"/);
});

await check('GPTBot fetching HTML gets the same HTML, tagged and logged', async () => {
  const { response, logs } = await run('/about', { ua: GPTBOT });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('x-irm-crawler'), 'GPTBot');
  const body = await response.text();
  assert.equal(body, readFileSync(join(root, 'about.html'), 'utf8'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ai-crawler name=GPTBot operator="OpenAI" path=\/about markdown=false/);
});

await check('/about.md renders Markdown with front matter and absolute links', async () => {
  const { response } = await run('/about.md', { ua: CLAUDEBOT });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('x-irm-crawler'), 'ClaudeBot');
  assert.match(response.headers.get('link'), /<https:\/\/infinityreachmedia\.com\/about>; rel="alternate"; type="text\/html"/);
  const md = await response.text();
  assert.match(md, /^---\ntitle: "About Yvette Kahn/);
  assert.match(md, /url: "https:\/\/infinityreachmedia\.com\/about"/);
  assert.match(md, /^# I'm Yvette Kahn\./m);
  assert.match(md, /\[Run your own numbers\]\(https:\/\/infinityreachmedia\.com\/scorecard\)/);
  assert.doesNotMatch(md, /<[a-z]+[ >]/i, 'no HTML tags may leak into the Markdown');
  assert.doesNotMatch(md, /Skip to main content|Privacy Policy · |nav-links/, 'nav and footer are stripped');
  assert.doesNotMatch(md, /\n\s*(EL|CA|CS)\n/, 'avatar initials are stripped');
  assert.match(md, /— Emily Haruko Leebs, Transformational Life Guide & Business Coach/);
});

await check('/index.md and /?format=md both render the homepage', async () => {
  const a = await (await run('/index.md')).response.text();
  const b = await (await run('/?format=md')).response.text();
  assert.equal(a, b);
  assert.match(a, /url: "https:\/\/infinityreachmedia\.com\/"/);
  assert.match(a, /# You're Losing Customers You Already Paid For\./);
  assert.match(a, /\*\*41 seconds\*\* average first reply/, 'adjacent inline elements are separated');
});

await check('Accept: text/markdown on a page URL returns Markdown', async () => {
  const { response } = await run('/faq', { accept: 'text/markdown, text/html;q=0.5' });
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(response.headers.get('vary'), 'Accept');
  const md = await response.text();
  assert.match(md, /\*\*What industries do you work with\?\*\*/, 'FAQ questions survive as bold lines');
});

await check('tables render as Markdown tables', async () => {
  const md = await (await run('/reactivation-playbook.md')).response.text();
  assert.match(md, /^\| Signal \| What it means \| What to do \|\n\| --- \| --- \| --- \|\n\| Bounces under 3%/m);
});

await check('noindex pages keep their HTML and have no Markdown rendering', async () => {
  for (const path of ['/thanks', '/jessica-intake', '/start', '/p/pilot-2026']) {
    const html = await run(path, { ua: GPTBOT });
    assert.equal(html.response.status, 200, path);
    assert.equal(html.response.headers.get('link'), null, `${path} must not advertise a .md alternate`);
    assert.match(html.response.headers.get('content-type'), /text\/html/);

    const md = await run(`${path}.md`, { ua: GPTBOT });
    assert.equal(md.response.status, 404, `${path}.md`);
    assert.equal(md.response.headers.get('x-robots-tag'), 'noindex');

    const negotiated = await run(path, { accept: 'text/markdown' });
    assert.match(negotiated.response.headers.get('content-type'), /text\/html/, `${path} via Accept must stay HTML`);
  }
});

await check('unknown .md URL is a 404, unknown page passes the site 404 through', async () => {
  const md = await run('/no-such-page.md');
  assert.equal(md.response.status, 404);
  const html = await run('/no-such-page');
  assert.equal(html.response.status, 404);
  assert.match(await html.response.text(), /Not found/);
});

await check('assets and non-GET requests are left alone', async () => {
  const txt = await run('/llms.txt', { accept: 'text/markdown' });
  assert.match(txt.response.headers.get('content-type'), /text\/plain/);
  assert.equal(txt.response.headers.get('link'), null);
  const post = await run('/about.md', { method: 'POST' });
  assert.notEqual(post.response.headers.get('content-type'), 'text/markdown; charset=utf-8');
});

await check('HEAD /about.md returns Markdown headers with an empty body', async () => {
  const { response } = await run('/about.md', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(await response.text(), '');
});

await check('every page in the repo converts cleanly', () => {
  const pages = readFileSync(join(root, 'sitemap.xml'), 'utf8').match(/<loc>[^<]+<\/loc>/g).map((l) => l.replace(/<\/?loc>/g, ''));
  for (const url of pages) {
    const path = new URL(url).pathname;
    const file = path === '/' ? 'index.html' : `${path.slice(1)}.html`;
    const page = htmlToMarkdown(readFileSync(join(root, file), 'utf8'), { url });
    assert.ok(page.title, `${file} has a title`);
    assert.ok(page.body.length > 300, `${file} renders more than a stub (${page.body.length} chars)`);
    assert.doesNotMatch(page.body, /<\/?[a-z][^>]*>/i, `${file} leaks HTML`);
    assert.doesNotMatch(page.body, /&[a-z]+;|&#\d+;/i, `${file} leaks entities`);
    assert.doesNotMatch(page.body, /^ +\S/m, `${file} has indented lines that are not list items`);
    assert.equal(page.noindex, false, `${file} is in the sitemap, so must be indexable`);
  }
});

await check('llms-full.txt is up to date with the pages', async () => {
  const { execFileSync } = await import('node:child_process');
  const before = existsSync(join(root, 'llms-full.txt')) ? readFileSync(join(root, 'llms-full.txt'), 'utf8') : '';
  execFileSync(process.execPath, [join(root, 'scripts/build-llms-full.mjs')], { stdio: 'ignore' });
  const after = readFileSync(join(root, 'llms-full.txt'), 'utf8');
  assert.equal(after, before, 'llms-full.txt was stale: run node scripts/build-llms-full.mjs and commit the result');
});

console.log(`\n${checks} checks passed`);
