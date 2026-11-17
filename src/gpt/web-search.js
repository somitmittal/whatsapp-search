/**
 * src/gpt/web-search.js — Privacy-Preserving Web Search Service
 *
 * Provides external information lookup for general public knowledge, documentation,
 * news, or facts outside WhatsApp.
 *
 * Privacy Guarantees:
 * - NO user credentials, cookies, or session tokens are ever transmitted.
 * - Outbound queries are strictly sanitized and stripped of private metadata.
 * - Out-of-the-box zero-config multi-source search (Wikipedia API + DuckDuckGo Instant Answers).
 * - Pluggable support for configured search APIs (Tavily, Serper, SearXNG) if keys are provided in env.
 * - Enforces strict request timeouts (default 5000ms) with AbortSignal.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Searches Tavily if TAVILY_API_KEY is present in env.
 */
async function searchTavily(query, apiKey, signal) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  const results = [];
  for (const item of (data.results || []).slice(0, 5)) {
    results.push({
      title: item.title || 'Result',
      snippet: item.content || '',
      url: item.url || '',
    });
  }
  return results;
}

/**
 * Searches Serper if SERPER_API_KEY is present in env.
 */
async function searchSerper(query, apiKey, signal) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ q: query, num: 5 }),
    signal,
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const data = await res.json();
  const results = [];
  for (const item of (data.organic || []).slice(0, 5)) {
    results.push({
      title: item.title || 'Result',
      snippet: item.snippet || '',
      url: item.link || '',
    });
  }
  return results;
}

/**
 * Searches SearXNG if SEARXNG_URL is present in env.
 */
async function searchSearxng(query, baseUrl, signal) {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
    signal,
  });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  const results = [];
  for (const item of (data.results || []).slice(0, 5)) {
    results.push({
      title: item.title || 'Result',
      snippet: item.content || item.snippet || '',
      url: item.url || '',
    });
  }
  return results;
}

/**
 * Zero-config default: DuckDuckGo Instant Answer API + Wikipedia Public Search API.
 */
async function searchZeroConfig(query, signal) {
  const [ddgRes, wikiRes] = await Promise.allSettled([
    fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
      headers: { 'User-Agent': USER_AGENT },
      signal,
    }).then((r) => (r.ok ? r.json() : null)),
    fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`, {
      headers: { 'User-Agent': 'WhatsAppGPT/1.0 (dev@searchable.ai)' },
      signal,
    }).then((r) => (r.ok ? r.json() : null)),
  ]);

  const results = [];
  const ddg = ddgRes.status === 'fulfilled' ? ddgRes.value : null;
  const wiki = wikiRes.status === 'fulfilled' ? wikiRes.value : null;

  // 1. DuckDuckGo primary abstract
  if (ddg?.AbstractText) {
    results.push({
      title: ddg.Heading || query,
      snippet: ddg.AbstractText,
      url: ddg.AbstractURL || 'https://duckduckgo.com/?q=' + encodeURIComponent(query),
    });
  }

  // 2. DuckDuckGo related topics
  if (Array.isArray(ddg?.RelatedTopics)) {
    for (const item of ddg.RelatedTopics.slice(0, 3)) {
      if (item.Text && item.FirstURL) {
        results.push({
          title: item.Text.slice(0, 60).replace(/\.\.\.$/, '') + '…',
          snippet: item.Text,
          url: item.FirstURL,
        });
      }
    }
  }

  // 3. Wikipedia search results
  if (Array.isArray(wiki?.query?.search)) {
    for (const item of wiki.query.search.slice(0, 4)) {
      const cleanSnippet = stripHtml(item.snippet);
      if (cleanSnippet) {
        results.push({
          title: item.title,
          snippet: cleanSnippet,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, '_'))}`,
        });
      }
    }
  }

  return results;
}

/**
 * Formats a list of search results into readable Markdown for the agent context.
 */
export function formatWebSearchResults(query, results) {
  if (!Array.isArray(results) || results.length === 0) {
    return `No web results found for "${query}". Try rephrasing with different public keywords.`;
  }

  const items = results.slice(0, 5).map((r, i) => {
    const title = r.title || 'Untitled';
    const snippet = r.snippet || '';
    const url = r.url ? `\n   Source: ${r.url}` : '';
    return `${i + 1}. **${title}**\n   ${snippet}${url}`;
  });

  return `Web search results for "${query}":\n\n${items.join('\n\n')}`;
}

/**
 * Executes a web search with timeout and privacy protection.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ text: string, payload?: object }>}
 */
export async function searchWeb(query, { timeoutMs = DEFAULT_TIMEOUT_MS, signal = null } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return { text: 'web_search needs a "query".' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('Web search request timed out')), timeoutMs);

  const onParentAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onParentAbort);

  try {
    let results = [];

    // Prioritize configured enterprise search APIs if available
    if (process.env.TAVILY_API_KEY) {
      try {
        results = await searchTavily(q, process.env.TAVILY_API_KEY, controller.signal);
      } catch (err) {
        console.warn('[WebSearch] Tavily failed, falling back to zero-config:', err.message);
      }
    } else if (process.env.SERPER_API_KEY) {
      try {
        results = await searchSerper(q, process.env.SERPER_API_KEY, controller.signal);
      } catch (err) {
        console.warn('[WebSearch] Serper failed, falling back to zero-config:', err.message);
      }
    } else if (process.env.SEARXNG_URL) {
      try {
        results = await searchSearxng(q, process.env.SEARXNG_URL, controller.signal);
      } catch (err) {
        console.warn('[WebSearch] SearXNG failed, falling back to zero-config:', err.message);
      }
    }

    if (!results || results.length === 0) {
      results = await searchZeroConfig(q, controller.signal);
    }

    const text = formatWebSearchResults(q, results);
    return {
      text,
      payload: {
        webSearch: {
          query: q,
          resultCount: results.length,
          results: results.slice(0, 5),
        },
      },
    };
  } catch (err) {
    const isTimeout = controller.signal.aborted || /timeout|aborted/i.test(err.message);
    const msg = isTimeout
      ? 'Web search request timed out. The external search service took too long to respond.'
      : `Web search was unable to reach external sources: ${err.message}`;
    return { text: msg };
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}
