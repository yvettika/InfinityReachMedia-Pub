/* ==========================================================================
   html-to-markdown.js — turns one of this site's pages into clean Markdown.

   Why this exists: an LLM crawler or agent that asks for a page gets the
   same copy a visitor reads, minus the chrome it cannot use. No nav, no
   footer, no scripts, no styles, no form controls. Headings, paragraphs,
   lists, links, tables, FAQ questions and answers all survive, with every
   link made absolute so a model can cite it.

   It is deliberately dependency free: a small tag tokenizer builds a tree,
   and a renderer walks it. That keeps it runnable in Deno at the edge
   (netlify/edge-functions/llm-crawlers.js) and in Node for the build step
   that writes /llms-full.txt (scripts/build-llms-full.mjs).

   Markup it understands is the markup these pages actually use. If a new
   page introduces an element that renders badly, add a rule to render()
   rather than reaching for a library.
   ========================================================================== */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Content of these is not HTML; swallow it whole up to the closing tag.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript']);

// Dropped entirely, children included.
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe',
  'video', 'audio', 'canvas', 'form', 'input', 'select', 'textarea', 'label',
  'header', 'nav', 'footer', 'object', 'embed', 'map', 'picture-source']);

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'dd',
  'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'main', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'ul', 'html', 'head']);

// Opening one of these implicitly closes an open <p> (HTML5 rules).
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details',
  'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'ul']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™',
  bull: '•', middot: '·', times: '×', rarr: '→', larr: '←',
  darr: '↓', uarr: '↑', harr: '↔', laquo: '«', raquo: '»',
  deg: '°', frac12: '½', frac14: '¼', frac34: '¾', euro: '€',
  pound: '£', cent: '¢', yen: '¥', sect: '§', para: '¶',
  dagger: '†', check: '✓', cross: '✗', star: '☆', starf: '★',
  hearts: '♥', infin: '∞', plusmn: '±', minus: '−', divide: '÷',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', sbquo: '‚', bdquo: '„',
  thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '‍', zwnj: '‌', shy: '' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

/* ---------- parser ---------- */

function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Parse an HTML document into a tree of { tag, attrs, children } / { text }. */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const n = html.length;

  while (i < n) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i);
      const end = next === -1 ? n : next;
      top().children.push({ text: html.slice(i, end) });
      i = end;
      continue;
    }
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/.exec(html.slice(i, i + 4096));
    if (!m) {
      // A stray "<" in text. Keep it as text and move on.
      top().children.push({ text: '<' });
      i += 1;
      continue;
    }
    i += m[0].length;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();

    if (closing) {
      // Pop to the nearest matching open element; ignore unmatched closers.
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === tag) { stack.length = s; break; }
      }
      continue;
    }

    if (tag === 'p' || CLOSES_P.has(tag)) {
      if (top().tag === 'p') stack.pop();
    }
    if (tag === 'li' && top().tag === 'li') stack.pop();
    if ((tag === 'dt' || tag === 'dd') && (top().tag === 'dt' || top().tag === 'dd')) stack.pop();
    if ((tag === 'td' || tag === 'th') && (top().tag === 'td' || top().tag === 'th')) stack.pop();
    if (tag === 'tr' && (top().tag === 'td' || top().tag === 'th')) stack.pop();
    if (tag === 'tr' && top().tag === 'tr') stack.pop();

    const node = { tag, attrs: parseAttrs(m[3]), children: [] };
    top().children.push(node);

    const selfClosing = /\/\s*$/.test(m[3]);
    if (VOID.has(tag) || selfClosing) continue;

    if (RAW_TEXT.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = html.slice(i);
      const cm = close.exec(rest);
      const end = cm ? i + cm.index : n;
      node.children.push({ text: html.slice(i, end) });
      i = cm ? end + cm[0].length : n;
      continue;
    }
    stack.push(node);
  }
  return root;
}

/* ---------- tree helpers ---------- */

function find(node, pred) {
  if (!node || node.text !== undefined) return null;
  if (pred(node)) return node;
  for (const child of node.children) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return null;
}

function textOf(node) {
  if (!node) return '';
  if (node.text !== undefined) return decodeEntities(node.text);
  return node.children.map(textOf).join('');
}

function classes(node) {
  return (node.attrs.class || '').split(/\s+/).filter(Boolean);
}

function hasClass(node, name) {
  return classes(node).includes(name);
}

/* ---------- renderer ---------- */

function absolute(href, baseUrl) {
  if (!href) return '';
  try { return new URL(href, baseUrl).href; } catch { return href; }
}

function inline(s) {
  // Collapse whitespace inside a line of running text.
  return s.replace(/[ \t\r\n ]+/g, ' ');
}

function escapeLineStart(line) {
  // A paragraph that happens to begin like Markdown syntax should stay prose.
  return line.replace(/^(\s*)([#>|]|[-+*]\s|\d+\.\s)/, (m, ws, tok) => `${ws}\\${tok}`);
}

function trimBlock(s) {
  return s.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

/**
 * Render a parsed node to Markdown.
 * ctx: { baseUrl, listDepth, ordered, index }
 */
function render(node, ctx) {
  if (node.text !== undefined) {
    return inline(decodeEntities(node.text));
  }
  const { tag, attrs } = node;

  if (DROP.has(tag)) return '';
  if (attrs['aria-hidden'] === 'true') return '';
  if (attrs.hidden !== undefined) return '';
  if (hasClass(node, 'skip-link') || hasClass(node, 'nav-toggle')) return '';
  // Decorative: emoji icon tiles, testimonial initials, screen-reader-only
  // hints like "(opens in a new tab)" that mean nothing in plain text.
  if (hasClass(node, 'icon') || hasClass(node, 'avatar') || hasClass(node, 'sr-only')) return '';
  if (tag === 'head') return '';

  // Testimonial attribution block: name and role on one line.
  if (hasClass(node, 'who')) {
    const parts = [];
    const collect = (n) => {
      if (n.text !== undefined) return;
      if (hasClass(n, 'avatar')) return;
      if (hasClass(n, 'name') || hasClass(n, 'role')) { parts.push(inline(textOf(n)).trim()); return; }
      n.children.forEach(collect);
    };
    collect(node);
    const line = parts.filter(Boolean).join(', ');
    return line ? `\n\n— ${line}\n\n` : '';
  }

  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = Number(tag[1]);
      const text = inline(renderChildren(node, ctx)).trim();
      return text ? `\n\n${'#'.repeat(level)} ${text}\n\n` : '';
    }
    case 'p': {
      const text = inline(renderChildren(node, ctx)).trim();
      return text ? `\n\n${escapeLineStart(text)}\n\n` : '';
    }
    case 'br':
      return '\n';
    case 'hr':
      return '\n\n---\n\n';
    case 'strong': case 'b': {
      const text = renderChildren(node, ctx).trim();
      return text ? `**${text}**` : '';
    }
    case 'em': case 'i': case 'cite': case 'dfn': {
      const text = renderChildren(node, ctx).trim();
      return text ? `*${text}*` : '';
    }
    case 'code': case 'kbd': case 'samp': {
      const text = textOf(node).trim();
      return text ? `\`${text}\`` : '';
    }
    case 'pre': {
      const text = textOf(node).replace(/^\n/, '').replace(/\s+$/, '');
      return text ? `\n\n\`\`\`\n${text}\n\`\`\`\n\n` : '';
    }
    case 'a': {
      const text = inline(renderChildren(node, ctx)).trim();
      const href = attrs.href || '';
      if (!text) return '';
      if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return text;
      return `[${text}](${absolute(href, ctx.baseUrl)})`;
    }
    case 'img': {
      const alt = (attrs.alt || '').trim();
      if (!alt || /logo/i.test(alt)) return '';
      return `![${alt}](${absolute(attrs.src, ctx.baseUrl)})`;
    }
    case 'ul': case 'ol': {
      const ordered = tag === 'ol';
      const start = Number(attrs.start) || 1;
      const items = node.children.filter((c) => c.tag === 'li');
      const out = items.map((li, idx) => renderListItem(li, {
        ...ctx, listDepth: (ctx.listDepth || 0) + 1, ordered, index: start + idx,
      })).join('\n');
      return out ? `\n\n${out}\n\n` : '';
    }
    case 'li':
      // A stray <li> outside a list: render as a bullet anyway.
      return renderListItem(node, { ...ctx, listDepth: (ctx.listDepth || 0) + 1, ordered: false, index: 1 });
    case 'blockquote': {
      const body = trimBlock(renderChildren(node, ctx));
      if (!body) return '';
      return `\n\n${body.split('\n').map((l) => `> ${l}`.replace(/\s+$/, '')).join('\n')}\n\n`;
    }
    case 'dl': {
      const parts = [];
      for (const child of node.children) {
        if (child.tag === 'dt') parts.push(`**${inline(renderChildren(child, ctx)).trim()}**`);
        else if (child.tag === 'dd') parts.push(`: ${inline(renderChildren(child, ctx)).trim()}`);
      }
      return parts.length ? `\n\n${parts.join('\n')}\n\n` : '';
    }
    case 'table':
      return renderTable(node, ctx);
    case 'details': {
      const summary = node.children.find((c) => c.tag === 'summary');
      const rest = node.children.filter((c) => c !== summary);
      const q = summary ? inline(renderChildren(summary, ctx)).trim() : '';
      const a = trimBlock(renderChildren({ tag: 'div', attrs: {}, children: rest }, ctx));
      return `\n\n${q ? `**${q}**\n\n` : ''}${a}\n\n`;
    }
    case 'summary':
      return `\n\n**${inline(renderChildren(node, ctx)).trim()}**\n\n`;
    case 'button': {
      // The FAQ accordion keeps its questions in buttons. Everything else
      // that is a button (menu toggles, CTAs, calculator controls) is UI.
      if (hasClass(node, 'faq-q')) {
        const q = inline(renderChildren(node, ctx)).trim();
        return q ? `\n\n**${q}**\n\n` : '';
      }
      return '';
    }
    case 'span': case 'small': case 'sup': case 'sub': case 'mark': case 'abbr':
    case 'time': case 'q': case 'u': case 's': case 'del': case 'ins': case 'label': {
      if (hasClass(node, 'eyebrow')) {
        const text = inline(renderChildren(node, ctx)).trim();
        return text ? `\n\n*${text}*\n\n` : '';
      }
      return renderChildren(node, ctx);
    }
    default: {
      const body = renderChildren(node, ctx);
      if (BLOCK.has(tag) || tag === 'div' || tag === 'section' || tag === 'article') {
        return body.trim() ? `\n\n${trimBlock(body)}\n\n` : '';
      }
      return body;
    }
  }
}

function renderChildren(node, ctx) {
  // Adjacent inline elements with no whitespace between them are usually
  // stacked by CSS on the page ("<strong>41 seconds</strong><span>average
  // first reply</span>"). Joined as-is they'd read "**41 seconds**average",
  // so put a space at any element-to-element seam where both sides are text.
  let out = '';
  let prevWasElement = false;
  for (const child of node.children) {
    const piece = render(child, ctx);
    if (!piece) continue;
    const isElement = child.text === undefined;
    if (isElement && prevWasElement && out && /\S$/.test(out) && /^\S/.test(piece)) out += ' ';
    out += piece;
    prevWasElement = isElement;
  }
  return out;
}

function renderListItem(li, ctx) {
  const indent = '  '.repeat(ctx.listDepth - 1);
  const marker = ctx.ordered ? `${ctx.index}.` : '-';
  // Render inline content and nested lists separately so nesting indents.
  const nested = li.children.filter((c) => c.tag === 'ul' || c.tag === 'ol');
  const own = li.children.filter((c) => !nested.includes(c));
  let text = trimBlock(renderChildren({ tag: 'div', attrs: {}, children: own }, ctx))
    .split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  let out = `${indent}${marker} ${text}`.replace(/\s+$/, '');
  for (const list of nested) {
    const sub = trimBlock(render(list, ctx));
    if (sub) out += `\n${sub}`;
  }
  return out;
}

function renderTable(table, ctx) {
  const rows = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.text !== undefined) continue;
      if (child.tag === 'tr') {
        const cells = child.children
          .filter((c) => c.tag === 'td' || c.tag === 'th')
          .map((c) => inline(renderChildren(c, ctx)).trim().replace(/\|/g, '\\|'));
        rows.push({ cells, header: child.children.some((c) => c.tag === 'th') });
      } else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') {
        walk(child);
      }
    }
  };
  walk(table);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.cells.length));
  const pad = (cells) => cells.concat(Array(width - cells.length).fill(''));
  const line = (cells) => `| ${pad(cells).join(' | ')} |`;
  const first = rows[0];
  const header = first.header ? first : { cells: Array(width).fill('') };
  const body = first.header ? rows.slice(1) : rows;
  const out = [line(header.cells), `| ${Array(width).fill('---').join(' | ')} |`, ...body.map((r) => line(r.cells))];
  const caption = table.children.find((c) => c.tag === 'caption');
  return `\n\n${caption ? `**${inline(textOf(caption)).trim()}**\n\n` : ''}${out.join('\n')}\n\n`;
}

/* ---------- document-level API ---------- */

function meta(root, test) {
  const node = find(root, (n) => n.tag === 'meta' && test(n.attrs));
  return node ? (node.attrs.content || '').trim() : '';
}

function yaml(value) {
  // Double-quoted YAML scalars share JSON's escaping rules.
  return JSON.stringify(value);
}

/**
 * Convert a full HTML page to Markdown.
 *
 * @param {string} html      the page source
 * @param {object} options
 * @param {string} options.url  canonical URL of the page (used to absolutise links,
 *                              overridden by the page's own <link rel="canonical">)
 * @returns {{ title, description, url, noindex, body, markdown }}
 */
export function htmlToMarkdown(html, options = {}) {
  const root = parseHtml(html);

  const titleNode = find(root, (n) => n.tag === 'title');
  const title = inline(textOf(titleNode)).trim();
  const description = meta(root, (a) => (a.name || '').toLowerCase() === 'description');
  const robots = meta(root, (a) => (a.name || '').toLowerCase() === 'robots');
  const noindex = /\bnoindex\b/i.test(robots);
  const canonical = find(root, (n) => n.tag === 'link' && (n.attrs.rel || '').toLowerCase() === 'canonical');
  const url = (canonical && canonical.attrs.href) || options.url || '';
  const baseUrl = url || 'https://infinityreachmedia.com/';

  const body = find(root, (n) => n.tag === 'body') || root;
  const main = find(body, (n) => n.tag === 'main') || body;
  const ctx = { baseUrl, listDepth: 0 };

  let text = render(main, ctx);
  text = text
    .split('\n')
    // Trim trailing space, and leading space except on nested list items
    // (the only place indentation carries meaning here).
    .map((l) => l.replace(/\s+$/, '').replace(/^[ \t]+(?!(?:[-*+]|\d+\.)\s)/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const front = ['---', `title: ${yaml(title)}`];
  if (description) front.push(`description: ${yaml(description)}`);
  if (url) front.push(`url: ${yaml(url)}`);
  front.push('---');

  const markdown = `${front.join('\n')}\n\n${text}\n`;
  return { title, description, url, noindex, body: text, markdown };
}
