import { describe, expect, test } from '@jest/globals';
import { cosineSimilarity, packF32, unpackF32, topKByCosine } from '../src/search/vector-math.js';
import { embeddableText } from '../src/search/embedding-text.js';
import EmbeddingIndexService from '../src/search/embedding-index-service.js';
import SmartSearch from '../src/search/smart-search.js';

describe('vector-math', () => {
  test('round-trips float32 blobs', () => {
    const src = new Float32Array([0.25, -0.5, 1]);
    const back = unpackF32(packF32(src));
    expect(Array.from(back)).toEqual(Array.from(src));
  });

  test('cosine is 1 for identical unit vectors', () => {
    const a = new Float32Array([1, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1);
    expect(cosineSimilarity(a, new Float32Array([0, 1]))).toBeCloseTo(0);
  });

  test('topK keeps highest scores', () => {
    const q = new Float32Array([1, 0]);
    const ranked = topKByCosine(q, [
      { id: 1, vector: new Float32Array([0, 1]) },
      { id: 2, vector: new Float32Array([1, 0]) },
      { id: 3, vector: new Float32Array([0.7, 0.7]) },
    ], 2);
    expect(ranked.map((r) => r.id)).toEqual([2, 3]);
  });
});

describe('embeddableText', () => {
  test('skips placeholder-only bodies', () => {
    expect(embeddableText({ text: '[image]' })).toBe('');
    expect(embeddableText({ text: '[image]', mediaCaption: 'x-ray' })).toBe('x-ray');
  });
});

describe('EmbeddingIndexService', () => {
  test('encodes pending rows and retrieves the semantic neighbor', async () => {
    const store = new Map();
    const messages = [
      { id: 1, text: 'pay the clinic invoice tomorrow', mediaCaption: '', mediaAiIndex: '', chatJid: 'a' },
      { id: 2, text: 'weather is nice', mediaCaption: '', mediaAiIndex: '', chatJid: 'a' },
    ];
    const db = {
      getPendingEmbeddingJobs: () => messages.filter((m) => !store.has(m.id)),
      upsertMessageEmbedding: ({ messageRowid, vector, dim }) => {
        store.set(messageRowid, { vector, dim, messageRowid });
      },
      iterateMessageEmbeddings: () => [...store.values()],
    };
    const encode = async (texts) => texts.map((t) => {
      if (/invoice|bill|pay/i.test(t)) return new Float32Array([1, 0]);
      return new Float32Array([0, 1]);
    });
    const svc = new EmbeddingIndexService({ db, encode, modelId: 'test' });
    expect(await svc.processPending(12)).toBe(2);
    const hits = await svc.searchSimilar('unpaid bill', null, 1);
    expect(hits[0].id).toBe(1);
  });

  test('does no encoder work while initial history ingestion is busy', async () => {
    let encoded = false;
    const svc = new EmbeddingIndexService({
      db: {
        getPendingEmbeddingJobs: () => {
          throw new Error('must not query while ingestion is busy');
        },
      },
      encode: async () => {
        encoded = true;
        return [];
      },
      shouldDefer: () => true,
    });

    await expect(svc.processPending(12)).resolves.toBe(0);
    expect(encoded).toBe(false);
  });

  test('keeps live and imported jobs in separate batches', async () => {
    const scopes = [];
    const stored = [];
    const db = {
      getPendingEmbeddingJobs: (limit, prio, model, opts) => {
        scopes.push(opts.sourceScope);
        return opts.sourceScope === 'live'
          ? [{ id: 7, text: 'recent live message', chatJid: 'live@g.us' }]
          : [{ id: 8, text: 'archive message', chatJid: 'archive@imported' }];
      },
      upsertMessageEmbedding: (row) => stored.push(row.messageRowid),
    };
    const svc = new EmbeddingIndexService({
      db,
      encode: async (texts) => texts.map(() => new Float32Array([1, 0])),
      modelId: 'test',
      isWaLive: () => true,
    });

    await expect(svc.processPending(12)).resolves.toBe(1);
    expect(scopes).toEqual(['live']);
    expect(stored).toEqual([7]);
  });
});

describe('SmartSearch hybrid merge', () => {
  test('adds embedding hits that FTS missed', async () => {
    const db = {
      searchMessages: () => [{ id: 10, text: 'keyword hit', timestamp: 2 }],
      searchThreadSummaries: () => [],
      searchFacts: () => [],
      searchSummaries: () => [],
      getAllMessagesLight: () => [],
      getMessagesByRowIds: (ids) => ids.map((id) => ({ id, text: 'semantic neighbor', timestamp: 1 })),
    };
    const embeddingIndex = {
      searchSimilar: async () => [{ id: 99, score: 0.9 }],
    };
    const search = new SmartSearch(db, null, { embeddingIndex });
    const hits = await search._instantSearch('appointment next week', null);
    expect(hits.map((h) => h.id).sort()).toEqual([10, 99]);
  });
});
