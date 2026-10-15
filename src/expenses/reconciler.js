import { expenseIdentity, normalizeText } from './expense-utils.js';

function result(type, chatEntry = null, sheetEntry = null, detail = '') {
  return { type, chatEntry, sheetEntry, detail };
}

function groupDuplicates(entries) {
  const groups = new Map();
  entries.forEach((entry, index) => {
    const key = expenseIdentity(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ entry, index });
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

function referenceKey(entry) {
  return normalizeText(entry.reference);
}

function referencesCompatible(left, right) {
  const a = referenceKey(left);
  const b = referenceKey(right);
  return !a || !b || a === b;
}

function unusedEntries(entries, used) {
  return entries
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ index }) => !used.has(index));
}

function sameReference(entry, entries, used) {
  const ref = referenceKey(entry);
  if (!ref) return [];
  return unusedEntries(entries, used)
    .filter(({ candidate }) => referenceKey(candidate) === ref);
}

function isExactReference(entry, candidate) {
  return Number(candidate.amountMinor) === Number(entry.amountMinor)
    && candidate.currency === entry.currency
    && candidate.direction === entry.direction;
}

function exactCandidates(entry, entries, used) {
  const identity = expenseIdentity(entry);
  return unusedEntries(entries, used).filter(({ candidate }) => (
    referencesCompatible(entry, candidate)
    && expenseIdentity(candidate) === identity
  ));
}

function amountMismatchCandidates(entry, entries, used) {
  const ref = referenceKey(entry);
  if (ref) {
    const byReference = entries
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate, index }) => (
        !used.has(index)
        && referenceKey(candidate) === ref
        && Number(candidate.amountMinor) !== Number(entry.amountMinor)
      ));
    if (byReference.length) return byReference;
  }
  const identity = expenseIdentity(entry, { includeAmount: false });
  return entries
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate, index }) => (
      !used.has(index)
      && referencesCompatible(entry, candidate)
      && expenseIdentity(candidate, { includeAmount: false }) === identity
      && Number(candidate.amountMinor) !== Number(entry.amountMinor)
    ));
}

export function reconcileExpenses(chatEntries = [], sheetEntries = []) {
  const discrepancies = [];
  const matches = [];
  const usedSheet = new Set();
  const ambiguousSheet = new Set();

  function reserve(candidates) {
    candidates.forEach(({ index }) => ambiguousSheet.add(index));
  }

  for (const group of groupDuplicates(chatEntries)) {
    discrepancies.push(result('duplicate', group[0].entry, null, `Repeated ${group.length} times in chat`));
  }
  for (const group of groupDuplicates(sheetEntries)) {
    discrepancies.push(result('duplicate', null, group[0].entry, `Repeated ${group.length} times in sheet`));
  }

  for (const chatEntry of chatEntries) {
    const referenced = sameReference(chatEntry, sheetEntries, usedSheet);
    const exactReferenced = referenced.filter(({ candidate }) => isExactReference(chatEntry, candidate));
    if (exactReferenced.length === 1) {
      usedSheet.add(exactReferenced[0].index);
      matches.push({ chatEntry, sheetEntry: exactReferenced[0].candidate });
      continue;
    }
    if (exactReferenced.length > 1) {
      reserve(exactReferenced);
      discrepancies.push(result(
        'needs_review',
        chatEntry,
        null,
        `Multiple sheet rows share reference ${chatEntry.reference}`,
      ));
      continue;
    }
    if (referenced.length === 1) {
      const candidate = referenced[0];
      usedSheet.add(candidate.index);
      const sameTerms = candidate.candidate.currency === chatEntry.currency
        && candidate.candidate.direction === chatEntry.direction;
      discrepancies.push(result(
        sameTerms ? 'amount_mismatch' : 'needs_review',
        chatEntry,
        candidate.candidate,
        sameTerms
          ? 'The same expense identity has a different amount'
          : 'The same reference has a different currency or direction',
      ));
      continue;
    }
    if (referenced.length > 1) {
      reserve(referenced);
      discrepancies.push(result('needs_review', chatEntry, null, 'Multiple sheet rows share this reference'));
      continue;
    }

    const exact = exactCandidates(chatEntry, sheetEntries, usedSheet);
    if (exact.length === 1) {
      usedSheet.add(exact[0].index);
      matches.push({ chatEntry, sheetEntry: exact[0].candidate });
      continue;
    }
    if (exact.length > 1) {
      reserve(exact);
      discrepancies.push(result(
        'needs_review',
        chatEntry,
        null,
        `Multiple sheet rows match this chat expense: ${exact.map((x) => x.candidate.sheetRow).join(', ')}`,
      ));
      continue;
    }

    const changedAmount = amountMismatchCandidates(chatEntry, sheetEntries, usedSheet);
    if (changedAmount.length === 1) {
      usedSheet.add(changedAmount[0].index);
      discrepancies.push(result(
        'amount_mismatch',
        chatEntry,
        changedAmount[0].candidate,
        'The same expense identity has a different amount',
      ));
      continue;
    }
    if (changedAmount.length > 1) {
      reserve(changedAmount);
      discrepancies.push(result('needs_review', chatEntry, null, 'Multiple possible amount-mismatch rows'));
      continue;
    }
    discrepancies.push(result('missing_from_sheet', chatEntry, null, 'Expense appears in chat but not in the sheet'));
  }

  sheetEntries.forEach((sheetEntry, index) => {
    if (!usedSheet.has(index) && !ambiguousSheet.has(index)) {
      discrepancies.push(result('only_in_sheet', null, sheetEntry, 'Sheet row has no matching chat expense'));
    }
  });

  const sum = (entries, direction) => entries
    .filter((entry) => entry.direction === direction)
    .reduce((total, entry) => total + Number(entry.amountMinor || 0), 0);
  return {
    matches,
    discrepancies,
    totals: {
      chatDebitMinor: sum(chatEntries, 'debit'),
      chatCreditMinor: sum(chatEntries, 'credit'),
      sheetDebitMinor: sum(sheetEntries, 'debit'),
      sheetCreditMinor: sum(sheetEntries, 'credit'),
    },
  };
}

