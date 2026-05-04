from __future__ import annotations

import re
from datetime import date, datetime
from typing import Optional

from dateutil import parser as date_parser


def clean_amount(value) -> Optional[float]:
    if value is None or (isinstance(value, float) and value != value):  # NaN
        return None
    if isinstance(value, (int, float)):
        return float(value) if value else None
    s = str(value).strip()
    if not s or s.lower() in ("-", "nil", "na", "n/a"):
        return None
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative = True
        s = s[1:-1]
    # Strip grouping commas and currency markers; do not remove "." — it is the decimal separator.
    s = re.sub(r"[\s₹,]", "", s)
    s = re.sub(r"(?i)^rs\.?", "", s)
    s = re.sub(r"[^\d.\-]", "", s)
    if not s or s == "-":
        return None
    try:
        n = float(s)
        return -abs(n) if negative else n
    except ValueError:
        return None


def parse_date(value) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    s = str(value).strip()
    if not s:
        return None
    try:
        dt = date_parser.parse(s, dayfirst=True)
        return dt.date()
    except (ValueError, TypeError):
        return None


def tally_csv_date(d: date) -> str:
    return d.strftime("%d-%m-%Y")
