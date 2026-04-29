import { describe, expect, test } from '@jest/globals';
import { buildFallbackMediaIndex } from '../src/search/media-index-service.js';

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
