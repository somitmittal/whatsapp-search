import { detectTimeRange } from '../src/gpt/retrieval.js';
import { enforceGroundedAnswer } from '../src/search/grounding.js';
import { defaultPaddleOcr } from '../src/ocr/paddle-ocr.js';

describe('WOW UX & Retrieval Fixes', () => {
  test('detectTimeRange spans across multiple dates in compound queries', () => {
    const now = new Date(2026, 10, 26, 14, 0, 0); // 26 Nov 2026
    const range = detectTimeRange(
      'Where did I fly on 18 Nov, what Blue Dart numbers did Rudraksh share, and what did Parul say today?',
      now,
    );
    expect(range).not.toBeNull();
    expect(range.multiDate).toBe(true);
    const nov18Start = Math.floor(new Date(2026, 10, 18, 0, 0, 0).getTime() / 1000);
    const nov26End = Math.floor(new Date(2026, 10, 26, 23, 59, 59).getTime() / 1000);
    expect(range.startTs).toBeLessThanOrEqual(nov18Start);
    expect(range.endTs).toBeGreaterThanOrEqual(nov26End);
  });

  test('PaddleOcrService drops portrait gibberish and avoids false currency expansion on 9rS', () => {
    expect(defaultPaddleOcr._normalizeOcrText('rS,\n9rS\nRS@RQ')).toBe('');
    const real = defaultPaddleOcr._normalizeOcrText('Paid to Swiggy\n100 Rs\nUPI Transaction');
    expect(real).toContain('₹100');
    expect(real).toContain('INR 100');
  });

  test('enforceGroundedAnswer strips orphaned lead-in headings when all child bullets are dropped', () => {
    const answer = [
      'Here are the recent receipts and PDF bills found:',
      '- Invented Coffee Shop receipt for ₹999',
      '- Fake Taxi invoice from Mars',
    ].join('\n');
    const transcript = 'Alice: Hello, how are you?';
    const res = enforceGroundedAnswer(answer, transcript);
    expect(res.text).toBe('');
  });
});
