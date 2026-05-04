from __future__ import annotations

import re
from typing import Dict, List, Optional


def _norm_header(h: str) -> str:
    s = str(h or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    return s


# Canonical roles → regex patterns on normalized header text
ROLE_PATTERNS: Dict[str, List[str]] = {
    "date": [
        r"^date$",
        r"txn\s*date",
        r"transaction\s*date",
        r"posting\s*date",
        r"tran\s*date",
    ],
    "value_date": [
        r"value\s*dt",
        r"value\s*date",
    ],
    "narration": [
        r"narration",
        r"particulars",
        r"description",
        r"remarks",
        r"transaction\s*details",
    ],
    "reference": [
        r"chq",
        r"cheque",
        r"ref\.?\s*no",
        r"reference",
        r"instrument",
    ],
    "debit": [
        r"withdrawal",
        r"debit",
        r"dr\.?",
        r"paid",
        r"outflow",
    ],
    "credit": [
        r"deposit",
        r"credit",
        r"cr\.?",
        r"received",
        r"inflow",
    ],
    "balance": [
        r"closing\s*balance",
        r"balance",
        r"running\s*balance",
    ],
    "amount": [
        r"^amount$",
        r"transaction\s*amount",
    ],
    "dr_cr": [
        r"dr\s*/\s*cr",
        r"debit\s*/\s*credit",
        r"type",
    ],
}


def match_role(header: str) -> Optional[str]:
    nh = _norm_header(header)
    for role, patterns in ROLE_PATTERNS.items():
        for p in patterns:
            if re.search(p, nh):
                return role
    return None


def infer_columns(headers: List[str]) -> Dict[str, int]:
    """Map role → column index (first match wins per role)."""
    mapping: Dict[str, int] = {}
    for i, h in enumerate(headers):
        role = match_role(h)
        if role and role not in mapping:
            mapping[role] = i
    return mapping


def headers_from_row(row: List[object]) -> List[str]:
    return [str(x).strip() if x is not None else "" for x in row]
