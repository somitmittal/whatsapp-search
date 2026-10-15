/**
 * Local end-to-end run for construction expense reconciliation.
 * Creates site spreadsheets and chat transcripts, then runs the real service,
 * database, report writer, and HTTP API. Chat extraction uses a fixture model
 * that returns grounded JSON plus one hallucinated message id.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const fixtureDir = join(root, 'fixtures', 'construction-expenses');
const sheetDir = join(fixtureDir, 'sheets');
const reportCopyDir = join(fixtureDir, 'reports');
const runtimeDir = join(tmpdir(), 'searchable-expense-e2e');

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(sheetDir, { recursive: true });
mkdirSync(reportCopyDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
process.env.DATA_DIR = runtimeDir;
process.env.WEB_PORT = '3097';
process.env.HOST = '127.0.0.1';

const failures = [];
function check(condition, label) {
  if (condition) console.log(`ok  ${label}`);
  else {
    failures.push(label);
    console.error(`FAIL ${label}`);
  }
}

const BUSINESS_DATE = '2026-10-15';
const EXTRACTIONS = {
  'andheri-ravi': { amount: '1250.50', currency: 'INR', direction: 'debit', payee: 'Ravi labour team', category: 'labour', description: 'Daily wages', reference: 'B-9' },
  'andheri-fuel': { amount: '500', currency: 'INR', direction: 'debit', payee: 'HP Petrol Pump', category: 'fuel', description: 'Diesel', reference: 'F-22' },
  'andheri-cement': { amount: '800', currency: 'INR', direction: 'debit', payee: 'Shyam', category: 'material', description: 'Cement bags', reference: '' },
  'andheri-refund': { amount: '200', currency: 'INR', direction: 'credit', payee: 'Hardware store', category: 'material', description: 'Refund', reference: 'R-1' },
  'andheri-auto-1': { amount: '300', currency: 'INR', direction: 'debit', payee: 'Auto driver', category: 'transport', description: 'Material transport', reference: 'T-4' },
  'andheri-auto-2': { amount: '300', currency: 'INR', direction: 'debit', payee: 'Auto driver', category: 'transport', description: 'Material transport', reference: 'T-4' },
  'andheri-mason': { amount: '900', currency: 'INR', direction: 'debit', payee: 'Mason crew', category: 'labour', description: 'Block work', reference: '' },
  'andheri-usd': { amount: '100', currency: 'USD', direction: 'debit', payee: 'Imported pump', category: 'equipment', description: 'Pump hire', reference: 'U-1' },
  'andheri-scrap': { amount: '150', currency: 'INR', direction: 'credit', payee: 'Scrap buyer', category: 'other', description: 'Scrap sale', reference: '' },
  'bandra-fuel': { amount: '750', currency: 'INR', direction: 'debit', payee: 'City Fuel', category: 'fuel', description: 'Diesel', reference: '' },
  'powai-wire': { amount: '400', currency: 'INR', direction: 'debit', payee: 'Site electrician', category: 'labour', description: 'Wiring', reference: '' },
};

const TRANSCRIPT = [
  ['andheri-ravi', 'Supervisor', 'Paid ₹1,250.50 to Ravi labour team for daily wages. Bill B-9.'],
  ['andheri-fuel', 'Supervisor', 'Paid ₹500 to HP Petrol Pump for diesel. Bill F-22.'],
  ['andheri-cement', 'Supervisor', 'Paid ₹800 to Shyam for cement bags.'],
  ['andheri-refund', 'Supervisor', 'Received ₹200 refund from Hardware store. Bill R-1.'],
  ['andheri-auto-1', 'Supervisor', 'Paid ₹300 to Auto driver for material transport. Bill T-4.'],
  ['andheri-auto-2', 'Supervisor', 'Paid ₹300 to Auto driver for material transport. Bill T-4.'],
  ['andheri-mason', 'Supervisor', 'Paid ₹900 to Mason crew for block work.'],
  ['andheri-usd', 'Supervisor', 'Paid $100 to Imported pump for pump hire. Bill U-1.'],
  ['andheri-scrap', 'Supervisor', 'Received ₹150 from Scrap buyer for scrap sale.'],
  ['andheri-chatter', 'Supervisor', 'Site meeting at 5pm. No expense.'],
  ['andheri-yesterday', 'Supervisor', 'Paid ₹999 to Old vendor for yesterday’s cement.'],
  ['bandra-fuel', 'Accountant', 'Paid ₹750 to City Fuel for diesel.'],
  ['powai-wire', 'Supervisor', 'Paid ₹400 to Site electrician for wiring.'],
];

function fixtureProvider(calls) {
  return {
    async chat(messages) {
      const content = String(messages?.[0]?.content || '');
      calls.push(content);
      if (content.startsWith('Map spreadsheet')) {
        const headers = JSON.parse(content.slice(content.indexOf('[')));
        const aliases = { 'work day': 'date', beneficiary: 'payee', rupees: 'amount' };
        const mapped = {};
        for (const header of headers) {
          const field = aliases[String(header).trim().toLowerCase()];
          if (field) mapped[header] = field;
        }
        return JSON.stringify(mapped);
      }
      const visible = new Set([...content.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]));
      const grounded = [...visible]
        .filter((id) => EXTRACTIONS[id])
        .map((id) => ({ source_message_id: id, date: BUSINESS_DATE, ...EXTRACTIONS[id] }));
      grounded.push({
        source_message_id: 'hallucinated-message',
        amount: '999',
        currency: 'INR',
        direction: 'debit',
        date: BUSINESS_DATE,
        payee: 'Invented vendor',
        description: 'Not in the transcript',
      });
      return JSON.stringify(grounded);
    },
  };
}

async function writeAndheriSheet() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Expenses');
  sheet.addRow(['Andheri Tower daily expenses']);
  sheet.addRow(['Date', 'Paid To', 'Category', 'Amount', 'Description', 'Reference', 'Direction']);
  const rows = [
    ['15/10/2026', 'Ravi labour team', 'labour', 1250.5, 'Daily wages', 'B-9', 'debit'],
    ['15/10/2026', 'HP Petrol Pump', 'fuel', 550, 'Diesel', 'F-22', 'debit'],
    ['15/10/2026', 'Hardware store', 'material', 200, 'Refund', 'R-1', 'credit'],
    ['15/10/2026', 'Auto driver', 'transport', 300, 'Material transport', 'T-4', 'debit'],
    ['15/10/2026', 'Tea stall', 'food', 150, 'Worker tea', '', 'debit'],
    ['15/10/2026', 'Mason crew', 'labour', 900, 'Block work', '', 'debit'],
    ['15/10/2026', 'Mason crew', 'labour', 900, 'Block work', '', 'debit'],
    ['15/10/2026', 'Imported pump', 'equipment', 100, 'Pump hire', 'U-1', 'debit'],
    ['15/10/2026', 'Scrap buyer', 'other', '(150)', 'Scrap sale', '', ''],
    ['15/10/2026', '', '', 'not-a-number', '', '', ''],
  ];
  rows.forEach((row) => sheet.addRow(row));
  const path = join(sheetDir, 'andheri-15-oct.xlsx');
  await workbook.xlsx.writeFile(path);
  return path;
}

async function writeBandraSheet() {
  const path = join(sheetDir, 'bandra-variant.csv');
  writeFileSync(path, 'Work day,Beneficiary,Rupees\n2026-10-15,City Fuel,750\n');
  return path;
}

async function writePowaiSheet() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Expenses');
  sheet.addRow(['Date', 'Paid To', 'Amount', 'Description']);
  sheet.addRow(['2026-10-15', 'Site electrician', 400, 'Wiring']);
  const path = join(sheetDir, 'powai-15-oct.xlsx');
  await workbook.xlsx.writeFile(path);
  return path;
}

function typeCounts(items) {
  return items.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] || 0) + 1;
    return counts;
  }, {});
}

const calls = [];
const sends = [];
const provider = fixtureProvider(calls);
const waClient = {
  async sendDocument(chatJid, reportPath, options) {
    sends.push({ chatJid, reportPath, options });
    return { key: { id: `sent-${sends.length}` } };
  },
};

const andheriPath = await writeAndheriSheet();
const bandraPath = await writeBandraSheet();
const powaiPath = await writePowaiSheet();
writeFileSync(join(sheetDir, 'broken.xlsx'), 'this is not a workbook');
writeFileSync(join(sheetDir, 'searchable-expense-report-99.xlsx'), 'report loop fixture');
writeFileSync(join(fixtureDir, 'transcript.json'), JSON.stringify({
  businessDate: BUSINESS_DATE,
  messages: TRANSCRIPT.map(([id, sender, text]) => ({ id, sender, text })),
  sheets: ['andheri-15-oct.xlsx', 'bandra-variant.csv', 'powai-15-oct.xlsx', 'broken.xlsx'],
}, null, 2));

const { default: Database } = await import('../src/storage/database.js');
const { default: ExpenseReconciliationService } = await import('../src/expenses/expense-reconciliation-service.js');
const { dayBoundsFromDate } = await import('../src/expenses/chat-expense-extractor.js');
const { LEGACY_TENANT_ID } = await import('../src/storage/tenant-constants.js');
const { runWithTenant } = await import('../src/storage/tenant-context.js');
const { default: WebServer } = await import('../src/web/server.js');

const db = new Database();
const bounds = dayBoundsFromDate(BUSINESS_DATE);
const noon = bounds.startTs + (12 * 3600);
const service = new ExpenseReconciliationService({
  db,
  getProvider: () => provider,
  getWaClient: () => waClient,
  onProgress: () => {},
});

function insert(row) {
  db.insertMessage({
    senderJid: 'staff@s.whatsapp.net',
    timestamp: noon,
    ...row,
  });
}

await runWithTenant(LEGACY_TENANT_ID, async () => {
  db.setSetting('smb_profile', 'personal');
  insert({
    messageId: 'andheri-sheet',
    chatJid: 'andheri-tower@g.us',
    chatName: 'Andheri Tower',
    sender: 'Accountant',
    text: 'andheri-15-oct.xlsx',
    mediaType: 'document',
    mediaPath: andheriPath,
  });
  for (const [id, sender, text] of TRANSCRIPT.filter(([messageId]) => messageId.startsWith('andheri-'))) {
    insert({
      messageId: id,
      chatJid: 'andheri-tower@g.us',
      chatName: 'Andheri Tower',
      sender,
      text,
      timestamp: id === 'andheri-yesterday' ? bounds.startTs - 3600 : noon,
    });
  }
  insert({
    messageId: 'bandra-sheet', chatJid: 'bandra-west@g.us', chatName: 'Bandra West',
    sender: 'Accountant', text: 'bandra-variant.csv', mediaType: 'document', mediaPath: bandraPath,
  });
  insert({
    messageId: 'bandra-fuel', chatJid: 'bandra-west@g.us', chatName: 'Bandra West',
    sender: 'Accountant', text: TRANSCRIPT.find(([id]) => id === 'bandra-fuel')[2],
  });
  insert({
    messageId: 'powai-sheet', chatJid: 'powai-site@g.us', chatName: 'Powai Site',
    sender: 'Accountant', text: 'powai-15-oct.xlsx', mediaType: 'document', mediaPath: powaiPath,
  });
  insert({
    messageId: 'powai-wire', chatJid: 'powai-site@g.us', chatName: 'Powai Site',
    sender: 'Supervisor', text: TRANSCRIPT.find(([id]) => id === 'powai-wire')[2],
  });
  insert({
    messageId: 'own-sheet', chatJid: 'andheri-tower@g.us', chatName: 'Andheri Tower',
    sender: 'You', text: 'andheri-15-oct.xlsx', mediaType: 'document', mediaPath: andheriPath,
  });
  insert({
    messageId: 'imported-sheet', chatJid: 'import_andheri@imported', chatName: 'Imported Andheri',
    sender: 'Accountant', text: 'andheri-15-oct.xlsx', mediaType: 'document', mediaPath: andheriPath,
  });
  insert({
    messageId: 'report-loop', chatJid: 'andheri-tower@g.us', chatName: 'Andheri Tower',
    sender: 'Accountant', text: 'searchable-expense-report-99.xlsx',
    mediaType: 'document', mediaPath: join(sheetDir, 'searchable-expense-report-99.xlsx'),
  });
  insert({
    messageId: 'broken-sheet', chatJid: 'broken-site@g.us', chatName: 'Broken Site',
    sender: 'Accountant', text: 'broken.xlsx', mediaType: 'document',
    mediaPath: join(sheetDir, 'broken.xlsx'),
  });

  check(await service.enqueueMessage('andheri-sheet', LEGACY_TENANT_ID) === null, 'personal profile does not reconcile');
  check(db.listExpenseReconciliationRuns().length === 0, 'personal profile creates no run');
  db.setSetting('smb_profile', 'construction');

  for (const id of ['own-sheet', 'imported-sheet', 'report-loop']) {
    check(await service.enqueueMessage(id, LEGACY_TENANT_ID) === null, `${id} is ignored`);
  }
  check(db.listExpenseReconciliationRuns().length === 0, 'ignored attachments create no runs');

  const broken = await service.enqueueMessage('broken-sheet', LEGACY_TENANT_ID);
  check(broken?.status === 'failed', 'invalid workbook is saved as failed');
  check(sends.length === 0, 'invalid workbook does not send a report');

  const andheri = await service.enqueueMessage('andheri-sheet', LEGACY_TENANT_ID);
  check(andheri?.status === 'completed', 'Andheri reconciliation completes');
  check(sends.length === 1 && sends[0].chatJid === 'andheri-tower@g.us', 'Andheri report is sent to the same group');
  check(sends[0].options.caption.includes('amount mismatch: 1'), 'report summary names the amount mismatch');
  check(!andheri.entries.some((entry) => entry.payee === 'Invented vendor'), 'hallucinated chat expense is dropped');
  check(!andheri.entries.some((entry) => entry.sourceMessageId === 'andheri-yesterday'), 'previous-day expense is excluded');
  check(!andheri.entries.some((entry) => entry.sourceMessageId === 'andheri-chatter'), 'non-expense chatter is excluded');
  check(andheri.entries.some((entry) => entry.payee === 'Scrap buyer' && entry.direction === 'credit'), 'parenthesized sheet amount becomes a credit');
  check(andheri.totals.matchedCount === 4, 'four Andheri rows match exactly');
  const counts = typeCounts(andheri.discrepancies);
  check(counts.duplicate === 2, 'duplicate chat and sheet rows are flagged');
  check(counts.amount_mismatch === 1, 'fuel amount mismatch is flagged');
  check(counts.missing_from_sheet === 2, 'cement and repeated transport entry are missing from the sheet');
  check(counts.needs_review === 2, 'ambiguous labour rows and currency conflict need review');
  check(counts.only_in_sheet === 1, 'tea expense exists only in the sheet');
  check(!andheri.discrepancies.some((item) => item.type === 'only_in_sheet' && item.sheetEntry?.payee === 'Mason crew'), 'ambiguous rows are not also marked sheet-only');

  const andheriPrompt = calls.find((content) => content.includes('[andheri-ravi]'));
  check(andheriPrompt && !andheriPrompt.includes('[andheri-yesterday]'), 'extraction transcript stays inside the business day');
  check(andheriPrompt.includes('[andheri-chatter]'), 'non-expense messages are still available as evidence');

  await service.enqueueMessage('andheri-sheet', LEGACY_TENANT_ID);
  check(sends.length === 1, 'completed Andheri run is not sent twice');

  const bandra = await service.enqueueMessage('bandra-sheet', LEGACY_TENANT_ID);
  check(calls.some((content) => content.startsWith('Map spreadsheet') && content.includes('Rupees')), 'variant CSV headers are inferred');
  check(bandra?.status === 'completed' && bandra.discrepancies.length === 0, 'variant CSV matches its chat expense');
  check(sends.some((send) => send.chatJid === 'bandra-west@g.us' && send.options.caption.includes('No discrepancies found.')), 'clean CSV sends a no-discrepancy summary');

  const stuck = db.createExpenseReconciliationRun({
    chatJid: 'powai-site@g.us',
    chatName: 'Powai Site',
    sourceMessageId: 'powai-sheet',
    sourceFileName: 'powai-15-oct.xlsx',
    sourceMediaPath: powaiPath,
    businessDate: BUSINESS_DATE,
  });
  db.updateExpenseReconciliationRun(stuck.id, { status: 'processing' });
  await service.recoverPending(LEGACY_TENANT_ID);
  const powai = db.getExpenseReconciliationRun(stuck.id);
  check(powai?.status === 'completed' && powai.discrepancies.length === 0, 'processing run recovers after restart');
  check(sends.filter((send) => send.chatJid === 'powai-site@g.us').length === 1, 'recovered run sends one report');

  const reportBook = new ExcelJS.Workbook();
  await reportBook.xlsx.readFile(andheri.reportPath);
  check(reportBook.worksheets.map((sheet) => sheet.name).join(',') === 'Summary,Discrepancies,Chat Expenses,Submitted Sheet', 'report workbook has all four tabs');
  writeFileSync(join(reportCopyDir, 'andheri-report.xlsx'), await reportBook.xlsx.writeBuffer());
});

const web = new WebServer({
  db,
  searchEngine: { getProvider: () => provider, setProvider() {} },
  summaryService: { setProvider() {}, setFallbackProvider() {}, isBusy: () => false },
  expenseReconciliationService: service,
});
await web.start();
try {
  const listResponse = await fetch('http://127.0.0.1:3097/api/expenses/runs');
  const list = await listResponse.json();
  check(listResponse.ok && list.runs?.length === 4, 'API lists all reconciliation runs');
  const andheriRun = list.runs.find((run) => run.chatName === 'Andheri Tower');
  const detailResponse = await fetch(`http://127.0.0.1:3097/api/expenses/runs/${andheriRun.id}`);
  const detail = await detailResponse.json();
  check(detail.discrepancies?.length === 8, 'API detail returns the Andheri diff');
  const reportResponse = await fetch(`http://127.0.0.1:3097/api/expenses/runs/${andheriRun.id}/report`);
  const reportBytes = Buffer.from(await reportResponse.arrayBuffer());
  check(reportResponse.ok && reportBytes.subarray(0, 2).toString() === 'PK', 'API downloads the XLSX report');
  const discrepancyId = detail.discrepancies[0].id;
  const resolveResponse = await fetch(`http://127.0.0.1:3097/api/expenses/discrepancies/${discrepancyId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution: 'reviewed in e2e' }),
  });
  check(resolveResponse.ok, 'API resolves a discrepancy');
  const resolved = await fetch(`http://127.0.0.1:3097/api/expenses/runs/${andheriRun.id}`).then((response) => response.json());
  check(resolved.discrepancies.find((item) => item.id === discrepancyId)?.resolution === 'reviewed in e2e', 'resolved note is persisted');
  const brokenRun = list.runs.find((run) => run.status === 'failed');
  const retryResponse = await fetch(`http://127.0.0.1:3097/api/expenses/runs/${brokenRun.id}/retry`, { method: 'POST' });
  check(retryResponse.status === 202, 'API queues a failed run for retry');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const retried = db.getExpenseReconciliationRun(brokenRun.id);
  check(retried.status === 'failed', 'retry of an invalid workbook stays failed and unsent');
} finally {
  await new Promise((resolve) => {
    web._wss.close();
    web._server.close(() => resolve());
  });
  db.close();
}

if (failures.length) {
  console.error(`\n${failures.length} end-to-end check(s) failed`);
  process.exit(1);
}
console.log('\nConstruction expense end-to-end checks passed');
console.log(`Fixtures: ${fixtureDir}`);
