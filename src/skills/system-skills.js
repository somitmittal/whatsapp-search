/**
 * Skills shipped with the app. Read-only. A user row with the same
 * namespace and slug overrides one of these; the override lives in SQLite.
 */
export const SYSTEM_SKILLS = [
  {
    namespace: 'accountant',
    slug: 'expense-reconciliation',
    name: 'Expense reconciliation',
    description: 'Compare site-chat expenses with a Phone-pay PDF / Excel sheet: pick a date, pick the file, then review the dry-run report.',
    kind: 'system',
    version: 2,
    needsCompleteness: true,
    inputs: {
      chat: { type: 'chat', required: true },
      date: { type: 'date', required: true },
      sheet: { type: 'attachment', required: true },
    },
    body: 'Ask which calendar date to check, then which sheet file for that date, then reconcile. Read chat messages covering that date span. Extract expense transactions in any category, language, or informal format. Include client advances as credits. Compare with all workbook rows. Match using references first, then date, amount, currency, direction, and details; keep ambiguous cases for review. Generate a dry-run report and offer other dates that still have sheets.',
  },
];
