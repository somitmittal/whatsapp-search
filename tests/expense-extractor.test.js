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
      datedMessage('m-one', 'Hello'),
      datedMessage('m-two', 'Thanks'),
    ], { date: '2026-10-15' });
    expect(result).toEqual([]);
    expect(provider.chat).toHaveBeenCalledTimes(4);
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
