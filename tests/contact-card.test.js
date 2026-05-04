import { describe, test, expect } from '@jest/globals';
import {
  parseVCardFields,
  formatVCardNField,
  normalizeContactEntry,
  buildContactPayloadFromInner,
} from '../src/whatsapp/contact-card.js';

describe('parseVCardFields', () => {
  test('reads FN, N, TEL, EMAIL with folded line', () => {
    const raw = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Jane Doe',
      'N:Doe;Jane;;;',
      'ORG:Acme',
      'TEL;type=CELL:+44 7700 900123',
      'EMAIL;TYPE=INTERNET:jane@example.com',
      'NOTE:hello\\, world',
      'END:VCARD',
    ].join('\r\n');
    const p = parseVCardFields(raw);
    expect(p.fn).toBe('Jane Doe');
    expect(p.n).toBe('Doe;Jane;;;');
    expect(p.org).toBe('Acme');
    expect(p.phones).toContain('+44 7700 900123');
    expect(p.emails).toContain('jane@example.com');
  });
});

describe('formatVCardNField', () => {
  test('combines given and family', () => {
    expect(formatVCardNField('Smith;Alice;;;')).toBe('Alice Smith');
  });
});

describe('buildContactPayloadFromInner', () => {
  test('single contactMessage', () => {
    const inner = {
      contactMessage: {
        displayName: 'Bob',
        vcard:
          'BEGIN:VCARD\nVERSION:3.0\nFN:Robert\nTEL;CELL:+15551234567\nEND:VCARD\n',
      },
    };
    const r = buildContactPayloadFromInner(inner);
    expect(r).toBeTruthy();
    expect(r.summaryText).toContain('Bob');
    expect(r.summaryText).toContain('+15551234567');
    expect(r.payload.kind).toBe('single');
    expect(r.payload.contacts).toHaveLength(1);
    expect(r.payload.contacts[0].phones.length).toBeGreaterThan(0);
  });

  test('contactsArrayMessage', () => {
    const inner = {
      contactsArrayMessage: {
        displayName: 'Team list',
        contacts: [
          { displayName: 'A', vcard: 'BEGIN:VCARD\nFN:A\nTEL:+1\nEND:VCARD\n' },
          { displayName: 'B', vcard: 'BEGIN:VCARD\nFN:B\nTEL:+2\nEND:VCARD\n' },
        ],
      },
    };
    const r = buildContactPayloadFromInner(inner);
    expect(r.payload.kind).toBe('array');
    expect(r.payload.title).toBe('Team list');
    expect(r.payload.contacts).toHaveLength(2);
  });
});

describe('normalizeContactEntry', () => {
  test('prefers displayName over empty FN', () => {
    const c = normalizeContactEntry({ displayName: 'Card Name', vcard: '' });
    expect(c.displayName).toBe('Card Name');
  });
});
