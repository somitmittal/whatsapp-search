/**
 * Seed four construction site groups with expense chat messages + statement sheets,
 * then optionally run reconciliation for each site.
 *
 * Usage:
 *   node scripts/seed-test-construction-sites.mjs
 *   node scripts/seed-test-construction-sites.mjs --run
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import config from '../src/config.js';
import Database from '../src/storage/database.js';
import { LEGACY_TENANT_ID } from '../src/storage/tenant-constants.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import {
  CONSTRUCTION_EXPENSE_AGENT_SETTING,
  CONSTRUCTION_EXPENSE_SITE_JIDS_SETTING,
  SMB_PROFILE_SETTING,
} from '../src/smb/profiles.js';
import ExpenseReconciliationService from '../src/expenses/expense-reconciliation-service.js';
import { createProvider } from '../src/llm/provider.js';
import {
  effectiveSearchApiKey,
  effectiveSummaryApiKey,
} from '../src/llm/defaults.js';

const SHOULD_RUN = process.argv.includes('--run');
const TODAY = new Date();

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayAgo(n) {
  const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - n);
  const date = ymd(d);
  return { date, dayStart: Math.floor(new Date(`${date}T08:00:00`).getTime() / 1000) };
}

const D0 = dayAgo(0);
const D1 = dayAgo(1);
const D2 = dayAgo(2);
const DATE = D0.date;
const DAY_START = D0.dayStart;

/**
 * Chat lines include Ref VOU-xxx so the reconciler can pair them with the sheet.
 * Intentional gaps: amount mismatch, missing-from-sheet, only-in-sheet.
 * Site 1 spans three days so Ask AI has denser history to work with.
 */
const SITES = [
  {
    n: 1,
    chatJid: '120363999000000001@g.us',
    chatName: 'Site 1',
    // [{ dayStart, text }] — timestamps follow each day's morning.
    messageEntries: [
      { dayStart: D2.dayStart, text: 'Paid diesel for excavator Rs. 4200 Ref VOU-S1-D2-01' },
      { dayStart: D2.dayStart, text: 'Paid bricks Rs. 9000 Ref VOU-S1-D2-02' },
      { dayStart: D2.dayStart, text: 'Paid mason wages Rs. 6500 Ref VOU-S1-D2-03' },
      { dayStart: D2.dayStart, text: 'Paid water tanker Rs. 1800 Ref VOU-S1-D2-04' },
      { dayStart: D1.dayStart, text: 'Paid labour for fuel Rs. 5100 Ref VOU-S1-D1-01' },
      { dayStart: D1.dayStart, text: 'Paid sand Rs. 4500 Ref VOU-S1-D1-02' },
      { dayStart: D1.dayStart, text: 'Paid electrician Rs. 3200 Ref VOU-S1-D1-03' },
      { dayStart: D1.dayStart, text: 'Received scrap sale Rs. 2500 Ref VOU-S1-D1-04' },
      { dayStart: D1.dayStart, text: 'Paid shuttering hire Rs. 4000 Ref VOU-S1-D1-05' },
      { dayStart: D0.dayStart, text: 'Paid labour for fuel Rs. 5000 Ref VOU-S1-01' },
      { dayStart: D0.dayStart, text: 'Paid for electricity Rs. 4000 Ref VOU-S1-02' },
      { dayStart: D0.dayStart, text: 'Paid cement supplier Rs. 12000 Ref VOU-S1-03' },
      { dayStart: D0.dayStart, text: 'Received advance from client Rs. 20000 Ref VOU-S1-04' },
      { dayStart: D0.dayStart, text: 'Paid labour wages Rs. 8500 Ref VOU-S1-05' },
      { dayStart: D0.dayStart, text: 'Paid hardware store Rs. 2750 Ref VOU-S1-06' },
    ],
    // D2: bricks mismatch. D1: shuttering missing from sheet, extra crane only in sheet.
    // D0: electricity mismatch, wages omitted, extra tool hire only in sheet.
    sheetRows: [
      [D2.date, 'Excavator diesel', 'Fuel pump', 4200, 'Debit', 4200, 'VOU-S1-D2-01'],
      [D2.date, 'Clay bricks', 'Brick Kiln', 8500, 'Debit', 12700, 'VOU-S1-D2-02'],
      [D2.date, 'Mason wages', 'Labour', 6500, 'Debit', 19200, 'VOU-S1-D2-03'],
      [D2.date, 'Water tanker', 'Jal Agency', 1800, 'Debit', 21000, 'VOU-S1-D2-04'],
      [D1.date, 'Diesel for mixer', 'Fuel pump', 5100, 'Debit', 5100, 'VOU-S1-D1-01'],
      [D1.date, 'River sand', 'Quarry', 4500, 'Debit', 9600, 'VOU-S1-D1-02'],
      [D1.date, 'Wiring work', 'Electrician', 3200, 'Debit', 12800, 'VOU-S1-D1-03'],
      [D1.date, 'Scrap sale', 'Kabadi', 2500, 'Credit', 10300, 'VOU-S1-D1-04'],
      [D1.date, 'Mobile crane hire', 'Crane Co', 6000, 'Debit', 16300, 'VOU-S1-D1-99'],
      [D0.date, 'Fuel for generator', 'Fuel pump', 5000, 'Debit', 5000, 'VOU-S1-01'],
      [D0.date, 'Electricity bill', 'SEB', 3500, 'Debit', 8500, 'VOU-S1-02'],
      [D0.date, 'Cement bags', 'Sharma Traders', 12000, 'Debit', 20500, 'VOU-S1-03'],
      [D0.date, 'Client advance', 'Client', 20000, 'Credit', 500, 'VOU-S1-04'],
      [D0.date, 'Hardware purchase', 'Hardware Store', 2750, 'Debit', 3250, 'VOU-S1-06'],
      [D0.date, 'Tool hire', 'Hire Mart', 1500, 'Debit', 4750, 'VOU-S1-99'],
    ],
  },
  {
    n: 2,
    chatJid: '120363999000000002@g.us',
    chatName: 'Site 2',
    messages: [
      'Paid labour for fuel Rs. 3000 Ref VOU-S2-01',
      'Paid for electricity Rs. 2500 Ref VOU-S2-02',
      'Paid sand and aggregate Rs. 7000 Ref VOU-S2-03',
      'Paid transport Rs. 1500 Ref VOU-S2-04',
      'Refund from vendor Rs. 1000 Ref VOU-S2-05',
    ],
    sheetRows: [
      [DATE, 'Diesel for JCB', 'Fuel pump', 3000, 'Debit', 3000, 'VOU-S2-01'],
      [DATE, 'Electricity charges', 'SEB', 2500, 'Debit', 5500, 'VOU-S2-02'],
      [DATE, 'Sand and aggregate', 'Quarry', 7000, 'Debit', 12500, 'VOU-S2-03'],
      [DATE, 'Material transport', 'Truck owner', 1500, 'Debit', 14000, 'VOU-S2-04'],
      [DATE, 'Vendor refund', 'Quarry', 1000, 'Credit', 13000, 'VOU-S2-05'],
    ],
  },
  {
    n: 3,
    chatJid: '120363999000000003@g.us',
    chatName: 'Site 3',
    messages: [
      'Paid labour for fuel Rs. 4500 Ref VOU-S3-01',
      'Paid for electricity Rs. 1800 Ref VOU-S3-02',
      'Paid steel rods Rs. 22000 Ref VOU-S3-03',
      'Paid food for labour Rs. 1200 Ref VOU-S3-04',
    ],
    sheetRows: [
      [DATE, 'Fuel for mixer', 'Fuel pump', 4500, 'Debit', 4500, 'VOU-S3-01'],
      [DATE, 'Electricity', 'SEB', 1800, 'Debit', 6300, 'VOU-S3-02'],
      [DATE, 'TMT steel', 'Steel Yard', 22000, 'Debit', 28300, 'VOU-S3-03'],
      [DATE, 'Labour meals', 'Canteen', 1200, 'Debit', 29500, 'VOU-S3-04'],
      [DATE, 'Scaffold rental', 'Hire Mart', 2500, 'Debit', 32000, 'VOU-S3-99'],
    ],
  },
  {
    n: 4,
    chatJid: '120363999000000004@g.us',
    chatName: 'Site 4',
    messages: [
      'Paid labour for fuel Rs. 6000 Ref VOU-S4-01',
      'Paid for electricity Rs. 3200 Ref VOU-S4-02',
      'Paid plumber Rs. 2800 Ref VOU-S4-03',
      'Paid tiles Rs. 15000 Ref VOU-S4-04',
      'Received material return credit Rs. 2000 Ref VOU-S4-05',
    ],
    sheetRows: [
      [DATE, 'Fuel purchase', 'Fuel pump', 6000, 'Debit', 6000, 'VOU-S4-01'],
      [DATE, 'Electricity bill', 'SEB', 3200, 'Debit', 9200, 'VOU-S4-02'],
      [DATE, 'Plumbing work', 'Ravi Plumber', 2800, 'Debit', 12000, 'VOU-S4-03'],
      [DATE, 'Floor tiles', 'Tile World', 15000, 'Debit', 27000, 'VOU-S4-04'],
      [DATE, 'Material return', 'Tile World', 2000, 'Credit', 25000, 'VOU-S4-05'],
    ],
  },
];

/** Account-statement style sheet with Amount + Type + Reference. */
async function writeSiteStatement(site, mediaDir) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Statement');
  // Use Direction (not Type) — "Type" aliases to category in the sheet parser.
  sheet.addRow(['Date', 'Particulars', 'Paid To', 'Amount', 'Direction', 'Balance', 'Reference']);
  for (const row of site.sheetRows) {
    sheet.addRow(row);
  }
  const fileName = `site-${site.n}-daily-statement.xlsx`;
  const path = join(mediaDir, fileName);
  await workbook.xlsx.writeFile(path);
  return { path, fileName };
}

async function main() {
  mkdirSync(config.mediaDir, { recursive: true });
  const mediaDir = join(config.mediaDir, 'test-construction-sites');
  mkdirSync(mediaDir, { recursive: true });

  const db = new Database();
  const siteJids = SITES.map((s) => s.chatJid);

  await runWithTenant(LEGACY_TENANT_ID, async () => {
    db.setSetting(SMB_PROFILE_SETTING, 'construction');
    db.setSetting(CONSTRUCTION_EXPENSE_AGENT_SETTING, '1');
    db.setSetting(CONSTRUCTION_EXPENSE_SITE_JIDS_SETTING, JSON.stringify(siteJids));

    const allRows = [];
    for (const site of SITES) {
      const { path, fileName } = await writeSiteStatement(site, mediaDir);
      const entries = Array.isArray(site.messageEntries)
        ? site.messageEntries
        : (site.messages || []).map((text) => ({ dayStart: DAY_START, text }));
      let t = entries[0]?.dayStart || DAY_START;
      let lastDay = null;
      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        if (entry.dayStart !== lastDay) {
          t = entry.dayStart;
          lastDay = entry.dayStart;
        }
        t += 120;
        allRows.push({
          messageId: `test-site${site.n}-msg-${i + 1}`,
          chatJid: site.chatJid,
          chatName: site.chatName,
          sender: i % 2 === 0 ? 'Supervisor' : 'Accountant',
          senderJid: `91990000000${site.n}${i}@s.whatsapp.net`,
          text: entry.text,
          timestamp: t,
        });
      }
      t += 300;
      allRows.push({
        messageId: `test-site${site.n}-sheet-1`,
        chatJid: site.chatJid,
        chatName: site.chatName,
        sender: 'Accountant',
        senderJid: `91990000009${site.n}@s.whatsapp.net`,
        text: fileName,
        mediaType: 'document',
        mediaPath: path,
        mediaCaption: fileName,
        timestamp: t,
      });
      console.log(`[seed] ${site.chatName}: ${entries.length} messages + ${fileName}`);
    }

    // Re-seed: delete prior test rows / runs for these JIDs so reruns stay clean.
    const delMsgs = db._db.prepare(
      `DELETE FROM messages WHERE tenant_id = ? AND chat_jid = ? AND message_id LIKE 'test-site%'`,
    );
    const delRuns = db._db.prepare(
      `DELETE FROM expense_reconciliation_runs WHERE tenant_id = ? AND chat_jid = ? AND source_message_id LIKE 'test-site%'`,
    );
    for (const jid of siteJids) {
      delRuns.run(LEGACY_TENANT_ID, jid);
      delMsgs.run(LEGACY_TENANT_ID, jid);
    }

    const { count } = db.insertMessageBatch(allRows);
    console.log(`[seed] inserted ${count} message row(s)`);
    console.log(`[seed] profile=construction agent=on sites=${siteJids.length}`);
  });

  if (!SHOULD_RUN) {
    console.log('[seed] Done. Re-run with --run to execute reconciliation for each site.');
    db.close();
    return;
  }

  await runWithTenant(LEGACY_TENANT_ID, async () => {
    const settings = db.getAllSettings() || {};
    const providerName = settings.summary_provider && settings.summary_provider !== 'same'
      ? settings.summary_provider
      : (settings.llm_provider || 'ollama');
    const apiKey = providerName === (settings.llm_provider || 'ollama')
      ? effectiveSearchApiKey(db)
      : effectiveSummaryApiKey(db);
    const model = settings.summary_model || settings.llm_model || undefined;
    const provider = await createProvider(providerName, apiKey, model);
    const waStub = {
      sendDocument: async (chatJid, reportPath, options) => {
        console.log(`[run] would send report to ${chatJid}: ${options?.fileName || reportPath}`);
        return { key: { id: `test-report-${Date.now()}` } };
      },
    };
    const service = new ExpenseReconciliationService({
      db,
      getProvider: () => provider,
      getWaClient: () => waStub,
    });

    for (const site of SITES) {
      console.log(`\n[run] ${site.chatName}…`);
      try {
        const result = await service.runForChat({ chatJid: site.chatJid }, LEGACY_TENANT_ID);
        if (!result) {
          console.log(`[run] ${site.chatName}: no result`);
          continue;
        }
        const totals = result.totals || {};
        console.log(`[run] ${site.chatName}: status=${result.status} chat=${totals.chatEntryCount} sheet=${totals.sheetEntryCount} matched=${totals.matchedCount} discrepancies=${totals.discrepancyCount || (result.discrepancies || []).length}`);
        for (const d of (result.discrepancies || []).slice(0, 8)) {
          console.log(`  - ${d.type}: ${d.detail || ''}`);
        }
        if (result.error) console.log(`  error: ${result.error}`);
      } catch (err) {
        console.error(`[run] ${site.chatName} failed:`, err.message);
      }
    }
  });

  db.close();
  console.log('\n[seed] Finished.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
