import { describe, expect, jest, test } from '@jest/globals';
import AdmZip from 'adm-zip';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  looksLikeExpensePdfName,
  parseExpensePdf,
  parsePhonePayExpenseLine,
  parsePhonePayPdfText,
  peelAmountTaxTotal,
} from '../src/expenses/pdf-sheet-parser.js';
import { extractSheetRowsWithModel } from '../src/expenses/document-sheet-parser.js';
import { parseExpenseSheet } from '../src/expenses/sheet-parser.js';

describe('Phone pay PDF expense parsing', () => {
  test('recognises Phone pay / daily expense PDF names', () => {
    expect(looksLikeExpensePdfName('Phone pay - 14.10.26.pdf')).toBe(true);
    expect(looksLikeExpensePdfName('00010636-Phone_pay_-_14.10.26.pdf')).toBe(true);
    expect(looksLikeExpensePdfName('phn pay 19.09.2026.pdf')).toBe(true);
    expect(looksLikeExpensePdfName('Receipt1789971369809.pdf')).toBe(false);
    expect(looksLikeExpensePdfName('daily.xlsx')).toBe(false);
  });

  test('peels glued amount + tax + total', () => {
    expect(peelAmountTaxTotal('250012.502513')).toMatchObject({ amount: 2500, tax: 12.5, total: 2513 });
    expect(peelAmountTaxTotal('5000255025')).toMatchObject({ amount: 5000, tax: 25, total: 5025 });
    expect(peelAmountTaxTotal('1700085.0017085')).toMatchObject({ amount: 17000, tax: 85, total: 17085 });
    expect(peelAmountTaxTotal('23421117.1123538')).toMatchObject({ amount: 23421, tax: 117.11, total: 23538 });
  });

  test('parses dated Phone pay lines', () => {
    expect(parsePhonePayExpenseLine('02.04.26Jcb diesel Lek250012.502513')).toMatchObject({
      dateRaw: '02.04.26',
      amount: 2500,
      total: 2513,
    });
    expect(parsePhonePayExpenseLine('14.10.26Diesel hydra ( Lc 26 ) 5000255025')?.description)
      .toMatch(/Diesel hydra/i);
    expect(parsePhonePayExpenseLine('28.04.26Electricty bill Lc 2623421117.1123538')).toMatchObject({
      amount: 23421,
      total: 23538,
    });
    expect(parsePhonePayExpenseLine('Total Dena hai 223,555')).toBeNull();
  });

  test('parses a real Phonpay export PDF when present', async () => {
    const path = join(
      process.cwd(),
      'data/media/import_whatsapp_chat_-_phonpay_imported/00010636-Phone_pay_-_14.10.26.pdf',
    );
    if (!existsSync(path)) return;
    const parsed = await parseExpensePdf(path, {
      fallbackDate: '2026-10-14',
      fileName: 'Phone pay - 14.10.26.pdf',
    });
    expect(parsed.entries.length).toBeGreaterThanOrEqual(3);
    expect(parsed.entries.some((e) => /diesel|hydra|labour|chanda/i.test(e.description))).toBe(true);
    expect(parsed.entries.every((e) => e.amountMinor > 0 && e.date)).toBe(true);
  });

  test('trusts the fast parser only when every dated line is understood', () => {
    const daily = [
      '13.10.26Total Dena hai 223,555',
      'Total 233,203',
      '14.10.26',
      'Total Dena hai 193,203',
      '14.10.26Diesel hydra ( Lc 26 ) 5000255025',
      '14.10.26Ramesh labour advance rewa ( Ctr work ) 15007.51507.5',
      '14.10.26Grg chanda ( p-way)310015.53115.5',
      'Santosh bhaiya -40000',
    ].join('\n');
    const fast = parsePhonePayPdfText(daily, { fallbackDate: '2026-10-14' });
    expect(fast.complete).toBe(true);
    expect(fast.sheet.entries.map((e) => [e.date, e.amountMinor / 100, e.direction])).toEqual([
      ['2026-10-14', 5000, 'debit'],
      ['2026-10-14', 1500, 'debit'],
      ['2026-10-14', 3100, 'debit'],
      ['2026-10-14', 40000, 'credit'],
    ]);

    const otherLayout = [
      '03.01.2026Harsh room rent 9500',
      '04.01.2026Flori advance mahroi 4000',
      'Diesel khbj 5000255025',
      'Remaining balance 61620',
    ].join('\n');
    expect(parsePhonePayPdfText(otherLayout, { fallbackDate: '2026-01-05' }).complete).toBe(false);
  });
});

describe('AI read of any expense document', () => {
  const provider = (rows) => ({ chat: jest.fn().mockResolvedValue(JSON.stringify(rows)) });

  test('keeps rows whose amounts are in the document and drops invented or phone-number rows', async () => {
    const text = 'S.NO\nCREDIT SUMIT BHAIYA\n8787070000+17870 rem\n25.12.2025Jcb diesel home 2500\n25.12.2025Premlal driver advance 7000\nRemaining balance 61620';
    const sheet = await extractSheetRowsWithModel(provider([
      { date: '2025-12-25', description: 'Jcb diesel home', amount: 2500, direction: 'debit' },
      { date: '25.12.2025', description: 'Premlal driver advance', amount: '7,000', direction: 'debit' },
      { date: '2025-12-25', description: 'Sumit', amount: 8787070000, direction: 'credit' },
      { date: '2025-12-25', description: 'made up', amount: 999, direction: 'debit' },
    ]), text, { fallbackDate: '2025-12-25', label: 'sumit bhaiya expenses 25.12.2025.pdf' });
    expect(sheet.entries.map((e) => [e.date, e.amountMinor, e.description])).toEqual([
      ['2025-12-25', 250000, 'Jcb diesel home'],
      ['2025-12-25', 700000, 'Premlal driver advance'],
    ]);
    expect(sheet.headers).toEqual(['Date', 'Description', 'Payee', 'Amount', 'Direction', 'Reference']);
  });

  describe('hisab printout with a glued fee/commission side table', () => {
    const text = [
      'Total dena hai',
      '46,447',
      '04.01.2026GRG labour paymnt 4*5002000',
      '04.01.2026Diesel khbj 5000',
      '05.01.2026Labour 4*500 & watchman 1000 (5days) grg3000',
      '05.01.2026',
      '204020',
      '255025',
      '12.52512.5',
      'Diesel khbj 5000255025',
      'ERC shiffting tractor bhada pqrs work 250012.52512.5',
    ].join('\n');

    test('hides side-table lines from the model and splits glued products and blocks', async () => {
      const ai = provider([]);
      await extractSheetRowsWithModel(ai, text, { fallbackDate: '2026-01-04' }).catch(() => {});
      const sent = ai.chat.mock.calls[0][0][0].content;
      expect(sent).toContain('GRG labour paymnt 4*500 = 2000');
      expect(sent).toContain('\nDiesel khbj 5000\n');
      expect(sent).toMatch(/^ERC shiffting tractor bhada pqrs work 2500$/m);
      expect(sent).not.toMatch(/^(204020|255025|12\.52512\.5)$/m);
    });

    test('uses the trailing total over a rate operand, inherits the date above, and rejects textless rows', async () => {
      const sheet = await extractSheetRowsWithModel(provider([
        { date: '2026-01-04', description: 'GRG labour paymnt', amount: 2000 },
        { date: '2026-01-05', description: 'Labour 4*500 & watchman', amount: 500 },
        { date: '2026-01-05', description: '', payee: '', amount: 5000 },
        { date: '2026-01-04', description: '', payee: 'Diesel khbj', amount: 5000 },
        { date: '2026-01-04', description: 'Diesel khbj', amount: 5000 },
        { date: '2026-01-04', description: 'ERC shiffting tractor bhada', amount: 2500 },
      ]), text, { fallbackDate: '2026-01-04' });
      expect(sheet.entries.map((e) => [e.date, e.amountMinor / 100, e.description])).toEqual([
        ['2026-01-04', 2000, 'GRG labour paymnt'],
        ['2026-01-05', 3000, 'Labour 4*500 & watchman'],
        ['2026-01-04', 5000, 'Diesel khbj'],
        ['2026-01-05', 5000, 'Diesel khbj'],
        ['2026-01-05', 2500, 'ERC shiffting tractor bhada'],
      ]);
    });
  });

  test('keeps number-only lines when text rows carry no amounts of their own', async () => {
    const ai = provider([]);
    await extractSheetRowsWithModel(ai, 'Diesel\nLabour\nCement\n5000\n1500\n4200', { fallbackDate: '2026-01-04' }).catch(() => {});
    expect(ai.chat.mock.calls[0][0][0].content).toContain('Cement\n5000\n1500\n4200');
  });

  test('reads text and Word files through the model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'expense-doc-'));
    const txt = join(dir, 'hisab.txt');
    writeFileSync(txt, '14.10.26 Cement 12 bags 4200\n14.10.26 Labour 1500\n');
    const fromText = await parseExpenseSheet(txt, {
      fileName: 'hisab.txt',
      fallbackDate: '2026-10-14',
      provider: provider([{ date: '2026-10-14', description: 'Cement 12 bags', amount: 4200 }, { date: '2026-10-14', description: 'Labour', amount: 1500 }]),
    });
    expect(fromText.entries.map((e) => e.amountMinor)).toEqual([420000, 150000]);

    const docx = join(dir, 'expenses.docx');
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from('<w:document><w:body><w:p><w:r><w:t>Diesel</w:t></w:r><w:r><w:tab/><w:t>3100</w:t></w:r></w:p></w:body></w:document>'));
    zip.writeZip(docx);
    const fromWord = await parseExpenseSheet(docx, {
      fileName: 'expenses.docx',
      fallbackDate: '2026-10-14',
      provider: provider([{ description: 'Diesel', amount: 3100 }]),
    });
    expect(fromWord.entries).toEqual([expect.objectContaining({ amountMinor: 310000, date: '2026-10-14', description: 'Diesel' })]);
  });

  test('reads a photographed sheet through the vision caption and explains non-vision models', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'expense-img-'));
    const photo = join(dir, 'sheet.jpg');
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff]));
    const vision = {
      caption: jest.fn().mockResolvedValue('Handwritten: 14/10 diesel 5000, labour 1500'),
      chat: jest.fn().mockResolvedValue(JSON.stringify([{ date: '2026-10-14', description: 'diesel', amount: 5000 }])),
    };
    const sheet = await parseExpenseSheet(photo, { fileName: 'sheet.jpg', fallbackDate: '2026-10-14', provider: vision });
    expect(sheet.entries.map((e) => e.amountMinor)).toEqual([500000]);

    const blind = { caption: jest.fn().mockResolvedValue('[Vision: pick a multimodal model on OpenRouter]'), chat: jest.fn() };
    await expect(parseExpenseSheet(photo, { fileName: 'sheet.jpg', provider: blind })).rejects.toThrow(/vision model/i);
  });
});
