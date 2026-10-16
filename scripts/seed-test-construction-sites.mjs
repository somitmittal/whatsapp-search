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
const DATE = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;
const DAY_START = Math.floor(new Date(`${DATE}T08:00:00`).getTime() / 1000);

/**
 * Chat lines include Ref VOU-xxx so the reconciler can pair them with the sheet.
 * Intentional gaps: amount mismatch, missing-from-sheet, only-in-sheet.
 */
const SITES = [
  {
    n: 1,
    chatJid: '120363999000000001@g.us',
    chatName: 'Site 1',
    messages: [
      'Paid labour for fuel Rs. 5000 Ref VOU-S1-01',
      'Paid for electricity Rs. 4000 Ref VOU-S1-02',
      'Paid cement supplier Rs. 12000 Ref VOU-S1-03',
      'Received advance from client Rs. 20000 Ref VOU-S1-04',
      'Paid labour wages Rs. 8500 Ref VOU-S1-05',
    ],
    // Electricity amount mismatch (3500 vs 4000). Wages omitted. Extra tool hire only in sheet.
    sheetRows: [
      // Date, Particulars, Paid To, Amount, Type, Balance, Reference
      [DATE, 'Fuel for generator', 'Fuel pump', 5000, 'Debit', 5000, 'VOU-S1-01'],
      [DATE, 'Electricity bill', 'SEB', 3500, 'Debit', 8500, 'VOU-S1-02'],
      [DATE, 'Cement bags', 'Sharma Traders', 12000, 'Debit', 20500, 'VOU-S1-03'],
      [DATE, 'Client advance', 'Client', 20000, 'Credit', 500, 'VOU-S1-04'],
      [DATE, 'Tool hire', 'Hire Mart', 1500, 'Debit', 2000, 'VOU-S1-99'],
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
      let t = DAY_START;
      for (let i = 0; i < site.messages.length; i += 1) {
        t += 120;
        allRows.push({
          messageId: `test-site${site.n}-msg-${i + 1}`,
          chatJid: site.chatJid,
          chatName: site.chatName,
          sender: i % 2 === 0 ? 'Supervisor' : 'Accountant',
          senderJid: `91990000000${site.n}${i}@s.whatsapp.net`,
          text: site.messages[i],
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
      console.log(`[seed] ${site.chatName}: ${site.messages.length} messages + ${fileName}`);
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
