import { describe, expect, test } from '@jest/globals';
import {
  extractRenderableTextFromInner,
  isContentPlaceholder,
  isControlOnlyContentType,
  peelNestedMessage,
  placeholderForContentType,
  legacyControlFramePlaceholders,
  OPAQUE_CONTENT_PLACEHOLDERS,
} from '../src/whatsapp/message-content.js';

describe('isControlOnlyContentType', () => {
  test.each([
    'protocolMessage',
    'senderKeyDistributionMessage',
    'messageContextInfo',
    'reactionMessage',
    'pollUpdateMessage',
    'placeholderMessage',
    'albumMessage',
  ])('%s is dropped before it reaches the DB', (ct) => {
    expect(isControlOnlyContentType(ct)).toBe(true);
  });

  test.each([
    'conversation',
    'extendedTextMessage',
    'imageMessage',
    'audioMessage',
    'callLogMesssage',
    'pollCreationMessage',
  ])('%s is real content and is kept', (ct) => {
    expect(isControlOnlyContentType(ct)).toBe(false);
  });

  test('missing content type is not treated as a control frame', () => {
    expect(isControlOnlyContentType(undefined)).toBe(false);
    expect(isControlOnlyContentType(null)).toBe(false);
  });
});

describe('placeholderForContentType', () => {
  test('known events read as plain English', () => {
    expect(placeholderForContentType('callLogMesssage')).toBe('[Call]');
    expect(placeholderForContentType('groupInviteMessage')).toBe('[Group invite]');
    expect(placeholderForContentType('orderMessage')).toBe('[Order]');
    expect(placeholderForContentType('pollCreationMessageV3')).toBe('[Poll]');
  });

  test('unknown types fall back to a readable split of the proto key', () => {
    expect(placeholderForContentType('liveLocationMessage')).toBe('[Live location]');
  });

  test('missing content type yields null so callers drop the row', () => {
    expect(placeholderForContentType(undefined)).toBeNull();
    expect(placeholderForContentType('')).toBeNull();
  });
});

describe('peelNestedMessage', () => {
  test('unwraps bot-forwarded → ephemeral → image so we never store [Bot Forwarded]', () => {
    const inner = peelNestedMessage({
      botForwardedMessage: {
        message: {
          ephemeralMessage: {
            message: {
              imageMessage: { mimetype: 'image/jpeg', caption: 'hi' },
            },
          },
        },
      },
    });
    expect(inner.imageMessage?.caption).toBe('hi');
  });

  test('unwraps deviceSentMessage', () => {
    const inner = peelNestedMessage({
      deviceSentMessage: {
        destinationJid: 'x@s.whatsapp.net',
        message: { conversation: 'hello' },
      },
    });
    expect(inner.conversation).toBe('hello');
  });
});

describe('legacyControlFramePlaceholders', () => {
  test('covers the "[protocol]" rows earlier builds wrote', () => {
    expect(legacyControlFramePlaceholders()).toContain('[protocol]');
    expect(legacyControlFramePlaceholders()).toContain('[reaction]');
  });

  test('includes opaque junk labels we no longer write', () => {
    for (const p of OPAQUE_CONTENT_PLACEHOLDERS) {
      expect(legacyControlFramePlaceholders()).toContain(p);
    }
  });

  test('one entry per dropped content type plus opaque labels (set-unique)', () => {
    const placeholders = legacyControlFramePlaceholders();
    expect(new Set(placeholders).size).toBe(placeholders.length);
  });
});

describe('isContentPlaceholder', () => {
  test('matches synthetic labels only', () => {
    expect(isContentPlaceholder('[Template]')).toBe(true);
    expect(isContentPlaceholder('[Call]')).toBe(true);
    expect(isContentPlaceholder('Hello [Template]')).toBe(false);
    expect(isContentPlaceholder('Real message')).toBe(false);
  });
});

describe('extractRenderableTextFromInner', () => {
  test('reads interactiveMessageTemplate body used by business broadcasts', () => {
    const text = extractRenderableTextFromInner({
      templateMessage: {
        interactiveMessageTemplate: {
          header: { title: 'Sale' },
          body: { text: '50% off today' },
          footer: { text: 'Reply STOP' },
        },
      },
    });
    expect(text).toBe('Sale\n50% off today\nReply STOP');
  });

  test('reads poll V3 name', () => {
    expect(extractRenderableTextFromInner({
      pollCreationMessageV3: { name: 'Lunch?' },
    })).toBe('Lunch?');
  });
});
