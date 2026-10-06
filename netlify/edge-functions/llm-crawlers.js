/* ==========================================================================
   llm-crawlers.js — Netlify Edge Function. The JavaScript side of letting
   LLM crawlers and AI agents use this site.

   robots.txt opts the crawlers in. llms.txt tells them what the company is.
   This function runs on every page request and does three things:

     1. Recognises a known LLM crawler from its User-Agent (shared list in
        ../lib/ai-crawlers.js, the twin of the robots.txt block), tags the
        response with an X-IRM-Crawler header and writes one log line per
        visit, so AI traffic is visible in the Netlify edge function logs.

     2. Advertises a Markdown rendering of every indexable page. Each HTML
        response gets a Link header pointing at the same URL with .md on the
        end, plus one pointing at /llms.txt, so an agent that lands on the
        HTML knows a cleaner version exists.

     3. Serves that Markdown rendering when asked for it, in any of three
        ways:
          - the .md URL:            /about.md
          - a query flag:           /about?format=md
          - content negotiation:    Accept: text/markdown
        The HTML is fetched from the same deployment and converted on the
        fly by ../lib/html-to-markdown.js, so there is nothing to regenerate
        when a page changes.

   Pages marked noindex (thank-you, intake, retired offers) keep their HTML
   and are never rendered to Markdown: /thanks.md is a 404.

   Browsers are untouched. A normal visit passes straight through with two
   extra response headers. The crawler list drives headers and logging
   only, never a different body: the Markdown is opt-in by request, which
   is what keeps this on the right side of "cloaking".

   Cost: edge invocations are metered with ordinary web requests on
   Netlify's credit plans, and the function is excluded from every asset
   path below, so it only runs for page URLs.
   ========================================================================== */

import { identifyAiCrawler } from '../lib/ai-crawlers.js';
import { htmlToMarkdown } from '../lib/html-to-markdown.js';

export const config = {
  path: '/*',
  excludedPath: [
    '/css/*', '/js/*', '/images/*', '/media/*', '/videos/*', '/.netlify/*',
    '/*.txt', '/*.xml', '/*.json', '/*.css', '/*.js', '/*.map',
    '/*.png', '/*.jpg', '/*.jpeg', '/*.gif', '/*.svg', '/*.webp', '/*.ico',
    '/*.mp4', '/*.mp3', '/*.webm', '/*.pdf', '/*.woff', '/*.woff2',
  ],
  // If anything in here throws, Netlify serves the page as if the function
  // did not exist. A bug in the Markdown path must never take the site down.
  onError: 'bypass',
};

const SITE = 'https://infinityreachmedia.com';
const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

export default async function handler(request, context) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return context.next();

  // Belt and braces alongside excludedPath: anything with a file extension
  // other than .html or .md is an asset, not a page.
  const ext = extensionOf(url.pathname);
  if (ext && ext !== 'html' && ext !== 'md') return context.next();

  const crawler = identifyAiCrawler(request.headers.get('user-agent') || '');
  const wantsMarkdown = ext === 'md' || url.searchParams.get('format') === 'md' || prefersMarkdown(request.headers.get('accept'));

  if (crawler) {
    log(context, `ai-crawler name=${crawler.name} operator=${JSON.stringify(crawler.operator)} path=${url.pathname} markdown=${wantsMarkdown}`);
  }

  if (!wantsMarkdown) {
    const response = await context.next();
    return decorateHtml(response, url, crawler);
  }

  /* ---------- Markdown rendering ---------- */

  // /about.md -> /about ; /index.md -> / ; /about.html?format=md -> /about.html
  const pagePath = ext === 'md' ? stripMarkdownExtension(url.pathname) : url.pathname;
  const source = pagePath === url.pathname
    ? await context.next()
    : await context.rewrite(new URL(pagePath, url.origin));

  // If the rewrite already came back as Markdown (another layer rendered it),
  // there is nothing left to do.
  if (source.ok && /text\/markdown/i.test(source.headers.get('content-type') || '')) return source;

  if (!source.ok || !isHtml(source)) {
    // Not a page (404, redirect, non-HTML). Hand back exactly what the site
    // would have said, except that a bare .md URL with no page behind it is
    // a plain 404 rather than a copy of the custom 404 page.
    if (ext === 'md') return notFound(url, crawler);
    return source;
  }

  const html = await source.text();
  const page = htmlToMarkdown(html, { url: canonicalFor(pagePath) });

  if (page.noindex) {
    // Private or retired page: never render it for machines.
    if (ext === 'md') return notFound(url, crawler);
    return new Response(html, { status: source.status, headers: passthroughHeaders(source.headers) });
  }

  const headers = new Headers({
    'content-type': MARKDOWN_TYPE,
    'cache-control': source.headers.get('cache-control') || 'public, max-age=0, must-revalidate',
    'vary': 'Accept',
    'x-robots-tag': 'all',
    'link': linkHeader(page.url || canonicalFor(pagePath), 'html'),
  });
  if (crawler) headers.set('x-irm-crawler', crawler.name);

  return new Response(method === 'HEAD' ? null : page.markdown, { status: 200, headers });
}

/* ---------- helpers ---------- */

function extensionOf(pathname) {
  const last = pathname.split('/').pop() || '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

function stripMarkdownExtension(pathname) {
  const bare = pathname.replace(/\.md$/i, '');
  if (bare === '/index' || bare === '') return '/';
  return bare;
}

function isHtml(response) {
  return /text\/html/i.test(response.headers.get('content-type') || '');
}

/**
 * True when the Accept header ranks text/markdown above text/html.
 * Browsers send "text/html" first with a wildcard fallback and never mention markdown, so
 * they are unaffected. Agents that send "text/markdown" (with or without
 * text/html at a lower q) get Markdown.
 */
export function prefersMarkdown(accept) {
  if (!accept) return false;
  let md = -1;
  let html = -1;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().split(';');
    const t = type.trim().toLowerCase();
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([\d.]+)/i.exec(p);
      if (m) q = parseFloat(m[1]);
    }
    if (t === 'text/markdown' || t === 'text/x-markdown') md = Math.max(md, q);
    else if (t === 'text/html' || t === 'application/xhtml+xml') html = Math.max(html, q);
  }
  return md > 0 && md >= html && html !== 1;
}

/** Canonical URL for a request path: no .html, no trailing index. */
function canonicalFor(pathname) {
  let p = pathname.replace(/\.html$/i, '');
  if (p === '/index') p = '/';
  return `${SITE}${p}`;
}

/** Link header advertising the other representation of the page. */
function linkHeader(canonical, target) {
  const links = [];
  if (target === 'markdown') {
    const isHome = canonical === SITE || canonical === `${SITE}/`;
    links.push(`<${isHome ? `${SITE}/index.md` : `${canonical}.md`}>; rel="alternate"; type="text/markdown"`);
  } else {
    links.push(`<${canonical}>; rel="alternate"; type="text/html"`);
  }
  links.push(`<${SITE}/llms.txt>; rel="alternate"; type="text/plain"; title="llms.txt"`);
  links.push(`<${SITE}/llms-full.txt>; rel="alternate"; type="text/plain"; title="llms-full.txt"`);
  return links.join(', ');
}

function appendHeader(headers, name, value) {
  const existing = headers.get(name);
  if (!existing) headers.set(name, value);
  else if (!existing.toLowerCase().includes(value.toLowerCase())) headers.set(name, `${existing}, ${value}`);
}

function passthroughHeaders(source) {
  const headers = new Headers(source);
  headers.delete('content-length');
  return headers;
}

/**
 * Normal HTML response: add the alternate links (indexable pages only) and
 * the crawler tag. Reads the body once to check for a noindex meta tag, then
 * returns an equivalent response with the extra headers.
 */
async function decorateHtml(response, url, crawler) {
  if (!response.ok || !isHtml(response)) {
    if (crawler) {
      const headers = passthroughHeaders(response.headers);
      headers.set('x-irm-crawler', crawler.name);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return response;
  }

  const html = await response.text();
  const headers = passthroughHeaders(response.headers);
  const noindex = /<meta[^>]+name=["']?robots["']?[^>]*content=["'][^"']*\bnoindex\b/i.test(html.slice(0, 20000));

  if (!noindex) {
    const canonical = (/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html.slice(0, 20000)) || [])[1]
      || canonicalFor(url.pathname);
    headers.set('link', linkHeader(canonical, 'markdown'));
    appendHeader(headers, 'vary', 'Accept');
  }
  if (crawler) headers.set('x-irm-crawler', crawler.name);

  return new Response(html, { status: response.status, statusText: response.statusText, headers });
}

function notFound(url, crawler) {
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' });
  if (crawler) headers.set('x-irm-crawler', crawler.name);
  return new Response(`No Markdown rendering for ${url.pathname}. Site index: ${SITE}/llms.txt\n`, { status: 404, headers });
}

function log(context, line) {
  try {
    if (context && typeof context.log === 'function') context.log(line);
    else console.log(line);
  } catch { /* logging must never break a response */ }
}
