from __future__ import annotations

from pathlib import Path
from typing import List

import pandas as pd

from ..models import BankTransaction
from .tabular import find_header_row, parse_rows_after_header


def _dataframe_to_rows(df: pd.DataFrame) -> List[List[object]]:
    rows: List[List[object]] = []
    for _, r in df.iterrows():
        rows.append([r.iloc[i] for i in range(len(r))])
    return rows


def parse_csv_or_excel(path: Path) -> List[BankTransaction]:
    suf = path.suffix.lower()
    if suf == ".csv":
        try:
            df = pd.read_csv(path, header=None, dtype=str, encoding="utf-8", encoding_errors="replace")
        except UnicodeDecodeError:
            df = pd.read_csv(path, header=None, dtype=str, encoding="latin-1", encoding_errors="replace")
    elif suf in (".xlsx", ".xls"):
        df = pd.read_excel(path, header=None, dtype=str, engine=None)
    else:
        raise ValueError(f"Unsupported tabular format: {suf}")

    rows = _dataframe_to_rows(df)
    hi = find_header_row(rows)
    if hi is None:
        return []
    return parse_rows_after_header(rows, hi)
