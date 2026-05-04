from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Optional


@dataclass
class BankTransaction:
    txn_date: date
    narration: str
    debit: Optional[float] = None
    credit: Optional[float] = None
    value_date: Optional[date] = None
    reference: Optional[str] = None
    balance: Optional[float] = None
    raw_row: dict = field(default_factory=dict)
