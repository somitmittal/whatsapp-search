/**
 * Skills shipped with the app. Read-only. A user row with the same
 * namespace and slug overrides one of these; the override lives in SQLite.
 */
export const SYSTEM_SKILLS = [
  {
    namespace: 'accountant',
    slug: 'expense-reconciliation',
    name: 'Expense reconciliation',
    description: 'Compare transactions of any expense category in a site chat with its Excel or CSV sheet and report missing, extra, ambiguous, and mismatched entries.',
    kind: 'system',
    version: 1,
    needsCompleteness: true,
    inputs: {
      chat: { type: 'chat', required: true },
      sheet: { type: 'attachment', required: true, default: 'latest' },
    },
    body: 'Read the chat messages covering every date represented in the selected workbook. Extract expense transactions in any category, language, or informal format without assuming a fixed vocabulary. Include client advances received as credit transactions alongside expenses. Compare them with all transaction rows across the workbook worksheets. Match using references first, then date, amount, currency, direction, and transaction details; keep ambiguous cases for review and never invent missing details. Include the source message and worksheet row for every result. Generate a dry-run report and do not post it until the user confirms.',
  },
];
