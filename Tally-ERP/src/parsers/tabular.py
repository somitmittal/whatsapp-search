from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from ..column_map import infer_columns, headers_from_row
from ..models import BankTransaction
from ..normalize import clean_amount, parse_date


def _header_looks_like_particulars(header: str) -> bool:
    h = header.lower()
    return any(k in h for k in ("particular", "description", "remarks", "details"))


def row_to_transaction(
    cells: Sequence[Any],
    colmap: Dict[str, int],
    narration_cols: Optional[List[int]] = None,
) -> Optional[BankTransaction]:
    def get(role: str) -> Any:
        idx = colmap.get(role)
        if idx is None or idx >= len(cells):
            return None
        return cells[idx]

    d = parse_date(get("date"))
    if d is None:
        return None

    narr_idx = colmap.get("narration")
    narration_parts: List[str] = []
    narr = get("narration")
    if narr is not None and str(narr).strip():
        narration_parts.append(str(narr).strip())
    if narration_cols:
        for i in narration_cols:
            if narr_idx is not None and i == narr_idx:
                continue
            if i < len(cells) and cells[i] is not None:
                s = str(cells[i]).strip()
                if s:
                    narration_parts.append(s)
    narration = " | ".join(narration_parts) if narration_parts else ""

    debit = clean_amount(get("debit"))
    credit = clean_amount(get("credit"))
    amt = clean_amount(get("amount"))
    dr_cr = get("dr_cr")
    if amt is not None and (debit is None and credit is None):
        s = str(dr_cr or "").strip().upper()
        if "DR" in s or "DEBIT" in s or "W" == s:
            debit = abs(amt)
        elif "CR" in s or "CREDIT" in s:
            credit = abs(amt)
        else:
            if amt < 0:
                debit = abs(amt)
            else:
                credit = abs(amt)

    ref = get("reference")
    reference = str(ref).strip() if ref is not None and str(ref).strip() else None
    bal = clean_amount(get("balance"))
    vd = parse_date(get("value_date"))

    if debit and credit:
        if debit >= credit:
            credit = None
        else:
            debit = None

    if debit is None and credit is None:
        return None

    return BankTransaction(
        txn_date=d,
        narration=narration or "(no narration)",
        debit=debit,
        credit=credit,
        value_date=vd,
        reference=reference,
        balance=bal,
        raw_row={str(i): cells[i] for i in range(min(len(cells), 50))},
    )


def find_header_row(rows: List[List[Any]], max_scan: int = 80) -> Optional[int]:
    for i, row in enumerate(rows[:max_scan]):
        headers = headers_from_row(row)
        cmap = infer_columns(headers)
        roles = set(cmap.keys())
        if "date" not in roles:
            continue
        has_amount = bool(
            {"debit", "credit", "amount"} & roles
            or ("amount" in roles and "dr_cr" in roles)
        )
        if not has_amount:
            continue
        if "narration" in roles or any(str(h).strip() and _header_looks_like_particulars(str(h)) for h in headers):
            return i
        if {"debit", "credit"} <= roles or "amount" in roles:
            return i
    return None


def parse_rows_after_header(
    rows: List[List[Any]],
    header_idx: int,
) -> List[BankTransaction]:
    header_row = rows[header_idx]
    headers = headers_from_row(header_row)
    colmap = infer_columns(headers)

    narration_cols: List[int] = []
    for j, h in enumerate(headers):
        nh = h.lower()
        if any(k in nh for k in ("narration", "particular", "description", "remarks")):
            narration_cols.append(j)

    out: List[BankTransaction] = []
    for row in rows[header_idx + 1 :]:
        if not row or all(x is None or str(x).strip() == "" for x in row):
            continue
        cells = list(row)
        while cells and (cells[-1] is None or str(cells[-1]).strip() == ""):
            cells.pop()
        txn = row_to_transaction(cells, colmap, narration_cols or None)
        if txn:
            out.append(txn)
    return out
