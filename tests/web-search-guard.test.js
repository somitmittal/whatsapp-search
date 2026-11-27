import { describe, it, expect, jest } from '@jest/globals';
import { validateWebSearchQuery } from '../src/gpt/web-search-guard.js';
import {
  searchWeb,
  formatWebSearchResults,
  detectWebSearchIntent,
  extractWebSearchQuery,
} from '../src/gpt/web-search.js';
import { createToolbox, TOOL_SPECS } from '../src/gpt/tools.js';
import { runAgent, parseToolCalls } from '../src/gpt/agent.js';
import { enforceGroundedAnswer } from '../src/search/grounding.js';

describe('Web Search Privacy Guardrail (validateWebSearchQuery)', () => {
  const mockDirectory = {
    list() {
      return {
        chats: [
          { chatName: 'Rohan Sharma', chatJid: '919876543210@s.whatsapp.net' },
          { chatName: 'Auntie Sunita 🌺', chatJid: '919123456789@s.whatsapp.net' },
          { chatName: 'Bangalore Flat 402 Owners', chatJid: '12345-6789@g.us' },
          { chatName: 'Work', chatJid: 'work@g.us' },
          { chatName: 'Home', chatJid: 'home@g.us' },
        ],
      };
    },
  };

  const mockContextMessages = [
    { sender: 'Dr. Vikram Patel', text: 'Please take 500mg paracetamol after dinner' },
    { sender: 'You', text: 'I transferred 25000 rupees for the deposit via NEFT' },
  ];

  it('allows safe public queries', () => {
    const safeQueries = [
      'capital of France',
      'how to install node.js 22 on mac',
      'latest features of python 3.12',
      'weather in Tokyo today',
      'how to work from home effectively', // Contains generic words "work" and "home"
      'general election 2024 results',
    ];

    for (const q of safeQueries) {
      const res = validateWebSearchQuery(q, {
        directory: mockDirectory,
        contextMessages: mockContextMessages,
      });
      expect(res.allowed).toBe(true);
      expect(res.cleanQuery).toBe(q);
    }
  });

  it('blocks phone numbers in various formats', () => {
    const phoneQueries = [
      'who is calling from +1 (555) 123-4567',
      'details on +91 98765 43210',
      'find info for 9876543210',
      'call 09876543210 now',
      'number 98765-43210 address',
    ];

    for (const q of phoneQueries) {
      const res = validateWebSearchQuery(q, { directory: mockDirectory });
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/phone number|numeric contact identifier/i);
    }
  });

  it('blocks WhatsApp JIDs', () => {
    const jidQueries = [
      'who owns 919876543210@s.whatsapp.net',
      'lookup 123456789-987654@g.us',
      'profile of 987654321@lid',
    ];

    for (const q of jidQueries) {
      const res = validateWebSearchQuery(q, { directory: mockDirectory });
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/private WhatsApp identifier/i);
    }
  });

  it('blocks email addresses', () => {
    const res = validateWebSearchQuery('contact user.name@domain.com online', { directory: mockDirectory });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/email address/i);
  });

  it('blocks UPI and payment IDs', () => {
    const upiQueries = [
      'pay rahul@okhdfcbank',
      'send money to vendor@paytm',
      'merchant payment som@okaxis',
      'qr code for test@upi',
    ];

    for (const q of upiQueries) {
      const res = validateWebSearchQuery(q, { directory: mockDirectory });
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/payment \/ UPI identifier/i);
    }
  });

  it('blocks credit/debit card numbers', () => {
    const res = validateWebSearchQuery('check card 4111 2222 3333 4444 balance', { directory: mockDirectory });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/card number/i);
  });

  it('blocks government ID numbers (PAN & SSN)', () => {
    const panRes = validateWebSearchQuery('tax status for ABCDE1234F', { directory: mockDirectory });
    expect(panRes.allowed).toBe(false);
    expect(panRes.reason).toMatch(/tax ID/i);

    const ssnRes = validateWebSearchQuery('lookup 123-45-6789 records', { directory: mockDirectory });
    expect(ssnRes.allowed).toBe(false);
    expect(ssnRes.reason).toMatch(/social security number/i);
  });

  it('blocks internal WhatsApp chat intent questions', () => {
    const internalQueries = [
      'who sent me a message in whatsapp',
      'what did someone say in my chats',
      'who texted me yesterday',
      'what is in our chat',
    ];

    for (const q of internalQueries) {
      const res = validateWebSearchQuery(q, { directory: mockDirectory });
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/internal WhatsApp messages/i);
    }
  });

  it('blocks queries containing contact names from address book', () => {
    const contactQueries = [
      'find background on Rohan Sharma',
      'where does Auntie Sunita live',
      'maintenance issues in Bangalore Flat 402 Owners',
    ];

    for (const q of contactQueries) {
      const res = validateWebSearchQuery(q, { directory: mockDirectory });
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/private contact or chat name/i);
    }
  });

  it('blocks queries containing sender names from active context messages', () => {
    const res = validateWebSearchQuery('medical license for Dr. Vikram Patel', {
      directory: mockDirectory,
      contextMessages: mockContextMessages,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/sender name "Dr\. Vikram Patel"/i);
  });

  it('blocks queries containing verbatim text from private messages', () => {
    const res = validateWebSearchQuery('transferred 25000 rupees for the deposit', {
      directory: mockDirectory,
      contextMessages: mockContextMessages,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/verbatim private message text/i);
  });

  it('blocks excessively long queries', () => {
    const longQuery = 'a'.repeat(201);
    const res = validateWebSearchQuery(longQuery, { directory: mockDirectory });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/maximum 200 characters/i);
  });
});

describe('Web Search Service (searchWeb & formatting)', () => {
  it('formats search results cleanly into Markdown', () => {
    const results = [
      {
        title: 'Node.js',
        snippet: 'Node.js is an open-source, cross-platform JavaScript runtime environment.',
        url: 'https://nodejs.org',
      },
      {
        title: 'Node.js Wikipedia',
        snippet: 'Node.js executes JavaScript code outside a web browser.',
        url: 'https://en.wikipedia.org/wiki/Node.js',
      },
    ];

    const formatted = formatWebSearchResults('nodejs runtime', results);
    expect(formatted).toContain('Web search results for "nodejs runtime":');
    expect(formatted).toContain('1. **Node.js**');
    expect(formatted).toContain('Source: https://nodejs.org');
    expect(formatted).toContain('2. **Node.js Wikipedia**');
  });

  it('handles empty results gracefully', () => {
    const formatted = formatWebSearchResults('nonexistentxyzterm123', []);
    expect(formatted).toContain('No web results found');
  });

  it('searchWeb returns empty query message when query is blank', async () => {
    const res = await searchWeb('');
    expect(res.text).toBe('web_search needs a "query".');
  });

  it('detects explicit web-search intent and cleans the outbound query', () => {
    const text = 'can u check which all buses are available Kichha to Gurgaon on 29th November, they are not in this chat, search web';
    expect(detectWebSearchIntent(text)).toBe(true);
    expect(detectWebSearchIntent('what did Rohan say yesterday?')).toBe(false);
    expect(extractWebSearchQuery(text)).toBe('buses Kichha to Gurgaon on 29th November');
  });

  it('attaches public booking hubs when free search misses travel schedules', async () => {
    const res = await searchWeb('buses Kichha to Gurgaon on 29th November', { timeoutMs: 8000 });
    expect(res.text).toMatch(/redBus|AbhiBus|MakeMyTrip/i);
    expect(res.payload?.webSearch?.resultCount).toBeGreaterThan(0);
  });

  it('grounds answers that cite web-search tool results (not only chats)', () => {
    const web = 'Web search results for "buses Kichha to Gurgaon":\n\n1. **redBus**\n   Public Indian bus booking site.\n   Source: https://www.redbus.in/';
    const answer = 'I could not find a live seat list. Check **redBus** for Kichha to Gurgaon buses.';
    const out = enforceGroundedAnswer(answer, web, 'buses Kichha to Gurgaon search web');
    expect(out.text).toMatch(/redBus/);
    expect(out.removed).toEqual([]);
  });
});

describe('Toolbox web_search integration', () => {
  it('TOOL_SPECS includes web_search with privacy guidance', () => {
    const spec = TOOL_SPECS.find((s) => s.name === 'web_search');
    expect(spec).toBeDefined();
    expect(spec.about).toMatch(/PRIVACY GUARD/i);
  });

  it('toolbox.web_search blocks privacy leaks before touching the network', async () => {
    const mockWebSearchService = {
      search: jest.fn(),
    };

    const toolbox = createToolbox({
      db: {},
      directory: {
        list: () => ({ chats: [{ chatName: 'Alice Johnson', chatJid: 'alice@s.whatsapp.net' }] }),
      },
      webSearchService: mockWebSearchService,
    });

    // 1. Private contact name
    const res1 = await toolbox.web_search({ query: 'Alice Johnson salary details' }, 500, {});
    expect(res1.text).toMatch(/Blocked by privacy guardrail/);
    expect(res1.payload?.privacyBlocked).toBe(true);
    expect(mockWebSearchService.search).not.toHaveBeenCalled();

    // 2. Phone number
    const res2 = await toolbox.web_search({ query: 'lookup +91 99999 88888' }, 500, {});
    expect(res2.text).toMatch(/Blocked by privacy guardrail/);
    expect(mockWebSearchService.search).not.toHaveBeenCalled();
  });

  it('toolbox.web_search forwards clean queries to the search service', async () => {
    const mockWebSearchService = {
      search: jest.fn().mockResolvedValue({
        text: 'Web search results for "capital of Japan":\n\n1. **Tokyo** - Capital of Japan.',
        payload: { webSearch: { resultCount: 1 } },
      }),
    };

    const toolbox = createToolbox({
      db: {},
      directory: { list: () => ({ chats: [] }) },
      webSearchService: mockWebSearchService,
    });

    const statusUpdates = [];
    const ctx = {
      status: (txt) => statusUpdates.push(txt),
      prefetched: [],
    };

    const res = await toolbox.web_search({ query: 'capital of Japan' }, 500, ctx);
    expect(mockWebSearchService.search).toHaveBeenCalledWith('capital of Japan', { budget: 500 });
    expect(res.text).toContain('Tokyo');
    expect(statusUpdates[0]).toContain('Searching the web for “capital of Japan”…');
  });
});

describe('Agent loop with web_search', () => {
  it('parseToolCalls parses CALL web_search lines', () => {
    const text = 'CALL {"tool":"web_search","args":{"query":"PyTorch 2.5 release date"}}';
    const calls = parseToolCalls(text);
    expect(calls).toEqual([
      { name: 'web_search', args: { query: 'PyTorch 2.5 release date' } },
    ]);
  });

  it('runAgent completes turn using web_search tool output with citation grounding', async () => {
    const mockToolbox = {
      web_search: jest.fn().mockResolvedValue({
        text: 'Web search results for "current year":\n\n1. **Calendar** - Current Gregorian year is 2026.',
        payload: { webSearch: { resultCount: 1 } },
      }),
    };

    let step = 0;
    const mockProvider = {
      name: 'mock',
      async chat(messages) {
        step++;
        if (step === 1) {
          return 'CALL {"tool":"web_search","args":{"query":"current year"}}';
        }
        return 'The current Gregorian year is 2026 based on the calendar.';
      },
    };

    const result = await runAgent({
      provider: mockProvider,
      system: 'You are WhatsApp GPT.',
      history: [],
      contextText: '',
      query: 'What is the current calendar year?',
      toolbox: mockToolbox,
      ctx: { prefetched: [] },
    });

    expect(mockToolbox.web_search).toHaveBeenCalled();
    expect(result.answer).toContain('2026');
  });
});
