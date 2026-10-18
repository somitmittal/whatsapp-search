import { expenseIdentity, normalizeText } from './expense-utils.js';

function result(type, chatEntry = null, sheetEntry = null, detail = '', candidateSheetEntries = null) {
  const item = { type, chatEntry, sheetEntry, detail };
  if (candidateSheetEntries?.length) item.candidateSheetEntries = candidateSheetEntries;
  return item;
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
    && candidate.direction === entry.direction
    && (!candidate.date || !entry.date || candidate.date === entry.date);
}

const GENERIC_TERMS = new Set(['paid', 'payment', 'expense', 'expenses', 'purchase', 'purchased', 'bill', 'invoice', 'amount']);

function expenseTerms(entry) {
  return new Set([
    entry.payee,
    entry.description,
    entry.category,
  ].flatMap((value) => normalizeText(value).split(' ')).filter((term) => term.length > 1 && !GENERIC_TERMS.has(term)));
}

function expenseTextOverlap(left, right) {
  const a = expenseTerms(left);
  const b = expenseTerms(right);
  if (!a.size || !b.size) return false;
  for (const term of a) if (b.has(term)) return true;
  return false;
}

function sameTransactionTerms(left, right) {
  return left.currency === right.currency && left.direction === right.direction
    && (!left.date || !right.date || left.date === right.date);
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
      && (
        expenseIdentity(candidate, { includeAmount: false }) === identity
        || (sameTransactionTerms(entry, candidate) && expenseTextOverlap(entry, candidate))
      )
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
        exactReferenced.map(({ candidate }) => candidate),
      ));
      continue;
    }
    if (referenced.length === 1) {
      const candidate = referenced[0];
      usedSheet.add(candidate.index);
      const sameTerms = sameTransactionTerms(candidate.candidate, chatEntry);
      discrepancies.push(result(
        sameTerms ? 'amount_mismatch' : 'needs_review',
        chatEntry,
        candidate.candidate,
        sameTerms
          ? 'The same expense identity has a different amount'
          : 'The same reference has a different date, currency, or direction',
      ));
      continue;
    }
    if (referenced.length > 1) {
      reserve(referenced);
      discrepancies.push(result(
        'needs_review', chatEntry, null, 'Multiple sheet rows share this reference',
        referenced.map(({ candidate }) => candidate),
      ));
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
        exact.map(({ candidate }) => candidate),
      ));
      continue;
    }

    // Payee wording can differ between a message and a spreadsheet row. When
    // amount, date, currency, direction, and at least one meaningful text token
    // agree, a single candidate is a safe match; ambiguous candidates need review.
    const sameAmount = unusedEntries(sheetEntries, usedSheet).filter(({ candidate }) => (
      referencesCompatible(chatEntry, candidate)
      && sameTransactionTerms(chatEntry, candidate)
      && Number(candidate.amountMinor) === Number(chatEntry.amountMinor)
      && expenseTextOverlap(chatEntry, candidate)
    ));
    if (sameAmount.length === 1) {
      usedSheet.add(sameAmount[0].index);
      matches.push({ chatEntry, sheetEntry: sameAmount[0].candidate });
      continue;
    }
    if (sameAmount.length > 1) {
      reserve(sameAmount);
      discrepancies.push(result(
        'needs_review', chatEntry, null, 'Multiple same-amount rows have similar expense details',
        sameAmount.map(({ candidate }) => candidate),
      ));
      continue;
    }

    // A unique same-day/same-terms amount can still be a likely counterpart
    // when names are abbreviated or absent. Keep it visible for review instead
    // of asserting both a missing chat match and an unrelated sheet-only row.
    const sameMoney = unusedEntries(sheetEntries, usedSheet).filter(({ candidate }) => (
      referencesCompatible(chatEntry, candidate)
      && sameTransactionTerms(chatEntry, candidate)
      && Number(candidate.amountMinor) === Number(chatEntry.amountMinor)
    ));
    if (sameMoney.length === 1) {
      const candidate = sameMoney[0];
      usedSheet.add(candidate.index);
      discrepancies.push(result(
        'needs_review',
        chatEntry,
        candidate.candidate,
        'Amount and date agree, but expense details differ; verify this match',
      ));
      continue;
    }
    if (sameMoney.length > 1) {
      reserve(sameMoney);
      discrepancies.push(result(
        'needs_review', chatEntry, null, 'Multiple sheet rows share this amount, date, currency, and direction',
        sameMoney.map(({ candidate }) => candidate),
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
      discrepancies.push(result(
        'needs_review', chatEntry, null, 'Multiple possible amount-mismatch rows',
        changedAmount.map(({ candidate }) => candidate),
      ));
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

