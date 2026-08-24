import { describe, expect, test } from '@jest/globals';
import {
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
