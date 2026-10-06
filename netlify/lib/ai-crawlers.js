/* ==========================================================================
   ai-crawlers.js — the LLM crawlers this site welcomes, as data.

   This is the JavaScript twin of the "AI search and assistants" block in
   /robots.txt. robots.txt is what a crawler reads before it fetches; this
   list is what the edge function (netlify/edge-functions/llm-crawlers.js)
   uses while it is serving the fetch, so it can recognise the visitor, tag
   the response, and log the visit.

   Keep the two in step: when a crawler is added to robots.txt, add it here,
   and the other way round. Each entry's `pattern` is matched case-insensitively
   against the User-Agent header.

   Pure ESM with no imports, so it runs unchanged in Deno (Netlify Edge) and
   Node (scripts/).
   ========================================================================== */

export const AI_CRAWLERS = [
  // OpenAI / ChatGPT
  { name: 'GPTBot',            operator: 'OpenAI',     purpose: 'training and search index', pattern: /GPTBot/i },
  { name: 'OAI-SearchBot',     operator: 'OpenAI',     purpose: 'ChatGPT search results',    pattern: /OAI-SearchBot/i },
  { name: 'ChatGPT-User',      operator: 'OpenAI',     purpose: 'fetch on behalf of a user', pattern: /ChatGPT-User/i },

  // Perplexity
  { name: 'PerplexityBot',     operator: 'Perplexity', purpose: 'search index',              pattern: /PerplexityBot/i },
  { name: 'Perplexity-User',   operator: 'Perplexity', purpose: 'fetch on behalf of a user', pattern: /Perplexity-User/i },

  // Anthropic / Claude
  { name: 'ClaudeBot',         operator: 'Anthropic',  purpose: 'training and search index', pattern: /ClaudeBot/i },
  { name: 'Claude-User',       operator: 'Anthropic',  purpose: 'fetch on behalf of a user', pattern: /Claude-User/i },
  { name: 'Claude-SearchBot',  operator: 'Anthropic',  purpose: 'search index',              pattern: /Claude-SearchBot/i },

  // Google AI surfaces (AI Overviews, Gemini grounding)
  { name: 'Google-Extended',   operator: 'Google',     purpose: 'Gemini grounding',          pattern: /Google-Extended/i },

  // Microsoft Copilot
  { name: 'Bingbot',           operator: 'Microsoft',  purpose: 'Bing and Copilot',          pattern: /bingbot/i },

  // Apple Intelligence
  { name: 'Applebot-Extended', operator: 'Apple',      purpose: 'Apple Intelligence',        pattern: /Applebot-Extended/i },
  { name: 'Applebot',          operator: 'Apple',      purpose: 'Siri and Spotlight',        pattern: /Applebot/i },

  // Common Crawl — feeds many downstream models
  { name: 'CCBot',             operator: 'Common Crawl', purpose: 'open web corpus',         pattern: /CCBot/i },

  // Meta AI
  { name: 'meta-externalagent', operator: 'Meta',      purpose: 'Meta AI',                   pattern: /meta-externalagent/i },

  // Others that identify themselves honestly and are welcome under the wildcard
  { name: 'Amazonbot',         operator: 'Amazon',     purpose: 'Alexa answers',             pattern: /Amazonbot/i },
  { name: 'DuckAssistBot',     operator: 'DuckDuckGo', purpose: 'DuckAssist answers',        pattern: /DuckAssistBot/i },
  { name: 'YouBot',            operator: 'You.com',    purpose: 'You.com answers',           pattern: /YouBot/i },
  { name: 'MistralAI-User',    operator: 'Mistral',    purpose: 'fetch on behalf of a user', pattern: /MistralAI-User/i },
  { name: 'cohere-ai',         operator: 'Cohere',     purpose: 'Cohere grounding',          pattern: /cohere-ai/i },
];

/**
 * Identify an LLM crawler from a User-Agent string.
 * Returns the matching entry, or null when the visitor is a browser or an
 * unlisted bot. Order matters only where one name contains another
 * (Applebot-Extended before Applebot).
 */
export function identifyAiCrawler(userAgent) {
  if (!userAgent) return null;
  for (const crawler of AI_CRAWLERS) {
    if (crawler.pattern.test(userAgent)) return crawler;
  }
  return null;
}
