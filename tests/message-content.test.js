import { describe, expect, test } from '@jest/globals';
import {
  extractRenderableTextFromInner,
  isContentPlaceholder,
  isControlOnlyContentType,
  placeholderForContentType,
  legacyControlFramePlaceholders,
} from '../src/whatsapp/message-content.js';

describe('isControlOnlyContentType', () => {
  test.each([
    'protocolMessage',
    'senderKeyDistributionMessage',
    'messageContextInfo',
    'reactionMessage',
    'pollUpdateMessage',
    'placeholderMessage',
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
  });

  test('unknown types fall back to a readable split of the proto key', () => {
    expect(placeholderForContentType('liveLocationMessage')).toBe('[Live Location]');
  });

  test('missing content type still yields something renderable', () => {
    expect(placeholderForContentType(undefined)).toBe('[Message]');
    expect(placeholderForContentType('')).toBe('[Message]');
  });
});

describe('legacyControlFramePlaceholders', () => {
  test('covers the "[protocol]" rows earlier builds wrote', () => {
    expect(legacyControlFramePlaceholders()).toContain('[protocol]');
    expect(legacyControlFramePlaceholders()).toContain('[reaction]');
  });

  test('one entry per dropped content type', () => {
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
          header: { title: 'mStock' },
          body: { text: 'Markets open — Nifty futures green.' },
          footer: { text: 'Reply STOP to opt out' },
        },
      },
    });
    expect(text).toContain('Markets open');
    expect(text).toContain('mStock');
  });

  test('reads hydratedFourRowTemplate content', () => {
    expect(extractRenderableTextFromInner({
      templateMessage: {
        hydratedFourRowTemplate: { hydratedContentText: 'Your OTP is 1234' },
      },
    })).toBe('Your OTP is 1234');
  });

  test('reads top-level interactiveMessage', () => {
    expect(extractRenderableTextFromInner({
      interactiveMessage: { body: { text: 'Tap below to continue' } },
    })).toBe('Tap below to continue');
  });

  test('reads hydrated HSM', () => {
    expect(extractRenderableTextFromInner({
      highlyStructuredMessage: {
        hydratedHsm: { hydratedTemplate: { hydratedContentText: 'Payment received' } },
      },
    })).toBe('Payment received');
  });
});
