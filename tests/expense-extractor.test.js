import { describe, expect, test, jest } from '@jest/globals';
import { extractChatExpenses, dayBoundsFromDate } from '../src/expenses/chat-expense-extractor.js';

const datedMessage = (messageId, text, day = '2026-10-15') => ({
  messageId,
  sender: 'Staff',
  text,
  timestamp: Math.floor(dayBoundsFromDate(day).startTs + 12 * 60 * 60),
});

describe('chat expense extraction', () => {
  test('accepts wrapped JSON, field aliases, arbitrary expense categories, and shorthand amounts', async () => {
    const provider = {
      chat: jest.fn().mockResolvedValue(`Result:\n\`\`\`json\n{"transactions":[{
        "message_id":"m-cloud","value":"1.5k","currency":"USD","direction":"debit",
        "vendor":"Cloud service","category":"software subscription","context":"Annual account renewal"
      }]}\n\`\`\``),
    };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-cloud', 'Cloud service annual account renewal 1.5k USD'),
    ], { date: '2026-10-15' });
    expect(result).toEqual([expect.objectContaining({
      sourceMessageId: 'm-cloud', amountMinor: 150000, currency: 'USD',
      category: 'software subscription', payee: 'Cloud service', date: '2026-10-15',
      sourceText: 'Cloud service annual account renewal 1.5k USD', sourceSender: 'Staff',
    })]);
  });

  test('retries invalid JSON and extracts localized or informal transaction wording', async () => {
    const provider = {
      chat: jest.fn()
        .mockResolvedValueOnce('The expense was 2500, here is the result {broken')
        .mockResolvedValueOnce(JSON.stringify([{ source_message_id: 'm-travel', amount: '2.5k', currency: 'INR', direction: 'debit', description: 'airport ride', category: 'travel' }])),
    };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-travel', 'Cab 2.5k airport ride paid'),
    ], { date: '2026-10-15' });
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(result[0]).toEqual(expect.objectContaining({ amountMinor: 250000, category: 'travel' }));
  });

  test('retries a valid but incomplete response for omitted transaction messages', async () => {
    const provider = {
      chat: jest.fn()
        .mockResolvedValueOnce(JSON.stringify([{ source_message_id: 'm-one', amount: 100, description: 'subscription' }]))
        .mockResolvedValueOnce(JSON.stringify([{ source_message_id: 'm-two', amount: 250, description: 'equipment rental' }])),
    };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-one', 'Subscription paid ₹100'),
      datedMessage('m-two', 'Paid ₹250 for equipment rental'),
    ], { date: '2026-10-15' });
    expect(result.map((entry) => entry.sourceMessageId)).toEqual(['m-one', 'm-two']);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  test('recovers a clear single-amount payment when the model omits it', async () => {
    const provider = { chat: jest.fn().mockResolvedValue('[]') };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-missing', 'Paid 500 for an unfamiliar site service'),
    ], { date: '2026-10-15' });
    expect(result).toEqual([expect.objectContaining({
      sourceMessageId: 'm-missing', amountMinor: 50000, direction: 'debit', category: 'other',
      description: 'Paid 500 for an unfamiliar site service',
    })]);
  });

  test('includes a received client advance as credit and recovers other site expenses', async () => {
    const provider = { chat: jest.fn().mockResolvedValue('[]') };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-1', 'Paid labour for fuel Rs. 5000 Ref VOU-S1-01'),
      datedMessage('m-2', 'Paid for electricity Rs. 4000 Ref VOU-S1-02'),
      datedMessage('m-3', 'Paid cement supplier Rs. 12000 Ref VOU-S1-03'),
      datedMessage('m-4', 'Received advance from client Rs. 20000 Ref VOU-S1-04'),
      datedMessage('m-5', 'Paid labour wages Rs. 8500 Ref VOU-S1-05'),
    ], { date: '2026-10-15' });
    expect(result.map((entry) => entry.sourceMessageId)).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5']);
    expect(result.map((entry) => entry.amountMinor)).toEqual([500000, 400000, 1200000, 2000000, 850000]);
    expect(result[0].reference).toBe('VOU-S1-01');
    expect(result[3]).toEqual(expect.objectContaining({ direction: 'credit', category: 'client advance', reference: 'VOU-S1-04' }));
  });

  test('keeps an ambiguous multi-amount transaction for manual correction', async () => {
    const provider = { chat: jest.fn().mockResolvedValue('[]') };
    await expect(extractChatExpenses(provider, [
      datedMessage('m-ambiguous', 'Paid Rs. 500 for supplies and Rs. 300 for delivery'),
    ], { date: '2026-10-15' })).rejects.toThrow(/could not safely read/i);
  });

  test('splits an invalid large response into smaller message batches', async () => {
    const provider = {
      chat: jest.fn()
        .mockResolvedValueOnce('not json')
        .mockResolvedValueOnce('still not json')
        .mockResolvedValueOnce('[]')
        .mockResolvedValueOnce('[]'),
    };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-one', 'Meet at gate 3'),
      datedMessage('m-two', 'Bring 2 helmets'),
    ], { date: '2026-10-15' });
    expect(result).toEqual([]);
    expect(provider.chat).toHaveBeenCalledTimes(4);
  });

  test('skips the model entirely when no message contains an amount', async () => {
    const provider = { chat: jest.fn() };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-one', 'Hello'),
      datedMessage('m-two', 'image omitted'),
    ], { date: '2026-10-15' });
    expect(result).toEqual([]);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  test('accepts positional rows from small models and ignores non-ISO currency noise', async () => {
    const provider = {
      chat: jest.fn().mockResolvedValue('["m-a", 1500, "diye", "debit", "2026-10-15", "Staff", "other", "labour", ""],\n["m-b", "40000", "INR", "credit", "2026-10-15", "", "", "funds", ""]'),
    };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-a', '1500'),
      datedMessage('m-b', '40000 diye'),
    ], { date: '2026-10-15' });
    expect(result.map((e) => [e.sourceMessageId, e.amountMinor, e.currency, e.direction, e.payee])).toEqual([
      ['m-a', 150000, 'INR', 'debit', ''],
      ['m-b', 4000000, 'INR', 'credit', ''],
    ]);
  });

  test('a single garbled batch does not fail the run when other batches are readable', async () => {
    const lines = Array.from({ length: 21 }, (_, i) => datedMessage(`m-${i}`, `Paid ${100 + i} for item ${i}`));
    const provider = {
      chat: jest.fn(async ([{ content }]) => (content.includes('[m-20]') && !content.includes('[m-0]')
        ? 'garbled'
        : JSON.stringify(lines.slice(0, 20).map((row, i) => ({ source_message_id: row.messageId, amount: 100 + i }))))),
    };
    const result = await extractChatExpenses(provider, lines, { date: '2026-10-15' });
    expect(result).toHaveLength(21);
    expect(result[20]).toEqual(expect.objectContaining({ sourceMessageId: 'm-20', amountMinor: 12000 }));
  });

  describe('real-world Hinglish PhonePe group', () => {
    const phonepeDay = [
      datedMessage('p-phone', '6260093951', '2026-10-14'),
      datedMessage('p-1500', '1500', '2026-10-14'),
      datedMessage('p-img', 'image omitted', '2026-10-14'),
      datedMessage('p-diesel', '5000/- Hydra diesel ke liye dalwa dijiye', '2026-10-14'),
      { ...datedMessage('p-paid', 'Paid using PhonePe UPI. Explore the app now: https://phon.pe/download \u200e<attached: 00010630-PHOTO-2026-10-14-10-20-01.jpg>', '2026-10-14'), mediaType: 'image' },
      datedMessage('p-fund', '40000 diye', '2026-10-14'),
    ];

    test('drops phone numbers, invented screenshot amounts, and zero rows the model returns', async () => {
      const provider = {
        chat: jest.fn().mockResolvedValue(JSON.stringify([
          { source_message_id: 'p-phone', amount: 6260093951, direction: 'debit' },
          { source_message_id: 'p-1500', amount: 1500, direction: 'debit', description: 'labour advance' },
          { source_message_id: 'p-diesel', amount: 5000, direction: 'debit', description: 'Hydra diesel' },
          { source_message_id: 'p-paid', amount: 1000, direction: 'debit', description: 'Paid using PhonePe UPI' },
          { source_message_id: 'p-paid', amount: 0, direction: 'credit' },
          { source_message_id: 'p-fund', amount: 40000, direction: 'credit', description: 'funds received' },
        ])),
      };
      const result = await extractChatExpenses(provider, phonepeDay, { date: '2026-10-14' });
      expect(result.map((e) => [e.sourceMessageId, e.amountMinor, e.direction])).toEqual([
        ['p-1500', 150000, 'debit'],
        ['p-diesel', 500000, 'debit'],
        ['p-fund', 4000000, 'credit'],
      ]);
      const transcript = provider.chat.mock.calls[0][0][0].content;
      expect(transcript).toContain('[image]');
      expect(transcript).not.toContain('phon.pe');
    });

    test('takes paid vs received from the wording when a small model flips it', async () => {
      const provider = {
        chat: jest.fn().mockResolvedValue(JSON.stringify({ expenses: [
          { source_message_id: 'p-1500', amount: 1500, direction: 'credit', description: 'None' },
          { source_message_id: 'p-diesel', amount: 5000, direction: 'credit' },
          { source_message_id: 'p-fund', amount: 40000, direction: 'debit' },
        ] })),
      };
      const result = await extractChatExpenses(provider, phonepeDay, { date: '2026-10-14' });
      expect(result.map((e) => [e.amountMinor, e.direction, e.description])).toEqual([
        [150000, 'debit', ''],
        [500000, 'debit', ''],
        [4000000, 'credit', ''],
      ]);
    });

    test('re-attributes an amount cited on the neighbouring image message', async () => {
      const provider = {
        chat: jest.fn().mockResolvedValue(JSON.stringify([
          { source_message_id: 'p-img', amount: 5000, direction: 'debit', description: 'Hydra diesel' },
          { source_message_id: 'p-1500', amount: 1500 },
          { source_message_id: 'p-fund', amount: 40000, direction: 'credit' },
        ])),
      };
      const result = await extractChatExpenses(provider, phonepeDay, { date: '2026-10-14' });
      expect(result.find((e) => e.amountMinor === 500000)?.sourceMessageId).toBe('p-diesel');
    });

    test('reads amounts from indexed screenshot text and keeps one row per paid request', async () => {
      const provider = {
        chat: jest.fn().mockResolvedValue(JSON.stringify([
          { source_message_id: 'p-diesel', amount: 5000, direction: 'debit' },
          { source_message_id: 'p-paid', amount: 5000, direction: 'debit' },
          { source_message_id: 'p-1500', amount: 1500 },
          { source_message_id: 'p-fund', amount: 40000, direction: 'credit' },
        ])),
      };
      const withOcr = phonepeDay.map((row) => (row.messageId === 'p-paid'
        ? { ...row, mediaAiIndex: 'PhonePe payment successful ₹5,000 paid to Hydra fuel UTR 412345678901' }
        : row));
      const result = await extractChatExpenses(provider, withOcr, { date: '2026-10-14' });
      expect(result.filter((e) => e.amountMinor === 500000).map((e) => e.sourceMessageId)).toEqual(['p-diesel']);
    });

    test('reports unreadable payment messages instead of failing the whole run', async () => {
      const provider = { chat: jest.fn().mockResolvedValue('[]') };
      const unreadable = [];
      const result = await extractChatExpenses(provider, [
        datedMessage('m-ambiguous', 'Paid Rs. 500 for supplies and Rs. 300 for delivery'),
        datedMessage('m-hindi', 'प्रदीप इसमें ₹10000 डाल दो'),
      ], { date: '2026-10-15', onUnreadable: (rows) => unreadable.push(...rows) });
      expect(result).toEqual([expect.objectContaining({ sourceMessageId: 'm-hindi', amountMinor: 1000000, direction: 'debit' })]);
      expect(unreadable.map((row) => row.messageId)).toEqual(['m-ambiguous']);
    });
  });

  test('uses the real source message ID when the model invents one', async () => {
    const provider = {
      chat: jest.fn()
        .mockResolvedValueOnce(JSON.stringify([{ source_message_id: 'invented', amount: 250, description: 'subscription' }]))
        .mockResolvedValueOnce(JSON.stringify([{ source_message_id: 'invented', amount: 250, description: 'subscription' }])),
    };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-real', 'Payment 250 for subscription'),
    ], { date: '2026-10-15' });
    expect(result).toEqual([expect.objectContaining({ sourceMessageId: 'm-real', amountMinor: 25000 })]);
  });

  test('does not treat numbered chatter or an incoming client invoice as missing expenses', async () => {
    const provider = { chat: jest.fn().mockResolvedValue('[]') };
    const result = await extractChatExpenses(provider, [
      datedMessage('m-boxes', 'Received 3 boxes of tiles at the site'),
      datedMessage('m-invoice', 'Invoice issued to client for Rs 25000'),
    ], { date: '2026-10-15' });
    expect(result).toEqual([]);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });
});
