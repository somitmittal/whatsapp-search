import { describe, test, expect } from '@jest/globals';
import {
  parseExportedChat,
  slugForImportChatJid,
  extractTextFromZip,
  decodeExportBuffer,
} from '../src/import/chat-import.js';

describe('parseExportedChat', () => {
  test('parses US-style bracket line', () => {
    const { messages } = parseExportedChat(
      '[3/15/24, 4:23:56 PM] Alice: Hello there\n[3/15/24, 4:24:00 PM] Bob: Hi',
      'Test',
    );
    expect(messages.length).toBe(2);
    expect(messages[0].sender).toBe('Alice');
    expect(messages[0].text).toBe('Hello there');
    expect(messages[1].sender).toBe('Bob');
  });

  test('parses Android dash line with a.m.', () => {
    const { messages } = parseExportedChat(
      '4/11/23, 11:26 a.m. - Alice: Morning\n4/11/23, 11:27 a.m. - Bob: Hey',
      'Test',
    );
    expect(messages.length).toBe(2);
    expect(messages[0].sender).toBe('Alice');
    expect(messages[0].text).toBe('Morning');
  });

  test('parses 24h EU bracket format', () => {
    const { messages } = parseExportedChat(
      '[22/10/2021, 14:32:15] Support: Ticket closed\n[22/10/2021, 14:33:00] You: Thanks',
      'Test',
    );
    expect(messages.length).toBe(2);
    expect(messages[0].sender).toBe('Support');
  });

  test('strips BOM and narrow no-break space before am/pm', () => {
    const narrow = '\u202f';
    const { messages } = parseExportedChat(
      `\uFEFF[14/05/2025, 6:38:34${narrow}PM] Name: ok`,
      'Test',
    );
    expect(messages.length).toBe(1);
    expect(messages[0].sender).toBe('Name');
    expect(messages[0].text).toBe('ok');
  });

  test('parses dotted date', () => {
    const { messages } = parseExportedChat('15.03.2024, 16:00 - User: Hallo', 'DE');
    expect(messages.length).toBe(1);
    expect(messages[0].sender).toBe('User');
    expect(messages[0].text).toBe('Hallo');
  });

  test('parses ISO date (year first)', () => {
    const { messages } = parseExportedChat(
      '2024-03-15, 14:30:22 - Alice: ISO format\n2024-03-15, 14:31:00 - Bob: ok',
      'Test',
    );
    expect(messages.length).toBe(2);
    expect(messages[0].sender).toBe('Alice');
    expect(messages[0].text).toBe('ISO format');
  });

  test('parses time with PM immediately after minutes (no space)', () => {
    const { messages } = parseExportedChat('[1/1/24, 2:30PM] You: compact', 'T');
    expect(messages.length).toBe(1);
    expect(messages[0].sender).toBe('You');
  });

  test('decodeExportBuffer handles UTF-16 LE BOM', () => {
    const line = '[1/1/24, 1:00:00 PM] X: hi';
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, 'utf16le')]);
    const text = decodeExportBuffer(body);
    const { messages } = parseExportedChat(text, 'Z');
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe('hi');
  });

  test('extractTextFromZip decodes UTF-16 chat file', async () => {
    const { default: AdmZip } = await import('adm-zip');
    const line = '[2/2/24, 3:00:00 PM] Y: hello';
    const inner = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, 'utf16le')]);
    const zip = new AdmZip();
    zip.addFile('WhatsApp Chat with Z/_chat.txt', inner);
    const text = extractTextFromZip(zip.toBuffer());
    const { messages } = parseExportedChat(text, 'Z');
    expect(messages.length).toBe(1);
    expect(messages[0].sender).toBe('Y');
  });

  test('parses Portuguese às between date and time', () => {
    const { messages } = parseExportedChat(
      '[22/10/2021 às 14:32:15] João: Olá',
      'T',
    );
    expect(messages.length).toBe(1);
    expect(messages[0].sender).toBe('João');
  });

  test('parses dot-separated time', () => {
    const { messages } = parseExportedChat('15.03.2024, 16.30.00 - User: Hallo', 'DE');
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe('Hallo');
  });

  test('extractTextFromZip picks txt that parses', async () => {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    zip.addFile('notes/readme.txt', Buffer.from('just readme no dates'));
    zip.addFile("WhatsApp Chat - Group/WhatsApp Chat - Group.txt", Buffer.from('[1/2/24, 1:00:00 PM] A: real'));
    const text = extractTextFromZip(zip.toBuffer());
    const { messages } = parseExportedChat(text, 'G');
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe('real');
  });

  test('continues multiline body', () => {
    const { messages } = parseExportedChat(
      '[1/1/24, 12:00:00 PM] A: line1\nsecond line\n[1/1/24, 12:01:00 PM] B: next',
      'T',
    );
    expect(messages.length).toBe(2);
    expect(messages[0].text).toContain('line1');
    expect(messages[0].text).toContain('second line');
  });
});

describe('slugForImportChatJid', () => {
  test('sanitizes special characters', () => {
    expect(slugForImportChatJid('Café / Team #1')).toMatch(/^caf/);
  });
});

describe('extractTextFromZip', () => {
  test('prefers WhatsApp chat txt over readme', async () => {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('not a chat'));
    zip.addFile('WhatsApp Chat with Bob/WhatsApp Chat with Bob.txt', Buffer.from('[1/1/24, 1:00:00 PM] X: hi'));
    const buf = zip.toBuffer();
    const text = extractTextFromZip(buf);
    expect(text).toContain('X: hi');
    expect(text).not.toContain('not a chat');
  });
});
