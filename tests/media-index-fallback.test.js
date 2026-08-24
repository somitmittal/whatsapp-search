import { describe, expect, test } from '@jest/globals';
import MediaIndexService, { buildFallbackMediaIndex } from '../src/search/media-index-service.js';

describe('buildFallbackMediaIndex', () => {
  test('uses caption and filename', () => {
    const s = buildFallbackMediaIndex({
      mediaPath: '/data/x/msg.ogg',
      mediaCaption: 'Meeting notes',
      text: '[audio]',
      mediaType: 'audio',
      messageId: 'abc',
    });
    expect(s).toContain('Meeting notes');
    expect(s).toContain('msg.ogg');
  });

  test('uses media type when nothing else', () => {
    const s = buildFallbackMediaIndex({
      mediaPath: '',
      mediaCaption: '',
      text: '[video]',
      mediaType: 'video',
      messageId: 'x',
    });
    expect(s).toContain('video');
  });
});

describe('MediaIndexService pull status', () => {
  test('exposes download progress from its active provider', () => {
    const pullStatus = {
      model: 'llama3.2:3b',
      status: 'downloading',
      percent: 42,
      detail: 'pulling model layer',
    };
    const service = new MediaIndexService({
      db: {},
      getProvider: () => ({ pullStatus }),
    });

    expect(service.getPullStatus()).toEqual(pullStatus);
  });
});

describe('MediaIndexService defers until message indexing is done', () => {
  test('processPending is a no-op while shouldDefer is true', async () => {
    const service = new MediaIndexService({
      db: { getPendingMediaIndexJobs: () => { throw new Error('must not load media jobs yet'); } },
      getProvider: () => ({}),
      shouldDefer: () => true,
    });
    await expect(service.processPending(12)).resolves.toBe(0);
  });

  test('processPending runs after shouldDefer becomes false', async () => {
    let defer = true;
    const service = new MediaIndexService({
      db: { getPendingMediaIndexJobs: () => [] },
      getProvider: () => ({}),
      shouldDefer: () => defer,
    });
    await expect(service.processPending(12)).resolves.toBe(0);
    defer = false;
    await expect(service.processPending(12)).resolves.toBe(0);
  });
});

describe('MediaIndexService source queues', () => {
  test('checks the imported queue only after the live queue is empty', async () => {
    const scopes = [];
    const service = new MediaIndexService({
      db: {
        getPendingMediaIndexJobs: (limit, prio, opts) => {
          scopes.push(opts.sourceScope);
          return [];
        },
      },
      getProvider: () => ({}),
      isWaLive: () => true,
    });

    await expect(service.processPending(12)).resolves.toBe(0);
    expect(scopes).toEqual(['live', 'imported']);
  });

  test('never mixes imported jobs into a non-empty live batch', async () => {
    const scopes = [];
    const service = new MediaIndexService({
      db: {
        getPendingMediaIndexJobs: (limit, prio, opts) => {
          scopes.push(opts.sourceScope);
          return opts.sourceScope === 'live' ? [{ messageId: 'live-1' }] : [{ messageId: 'import-1' }];
        },
      },
      getProvider: () => ({}),
      isWaLive: () => true,
    });
    service._indexOne = async () => true;

    await expect(service.processPending(12)).resolves.toBe(1);
    expect(scopes).toEqual(['live']);
  });
});
