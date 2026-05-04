from __future__ import annotations

from pathlib import Path
from typing import List

import pdfplumber

from ..models import BankTransaction
from .tabular import find_header_row, parse_rows_after_header


def _tables_to_rows(pdf_path: Path) -> List[List[object]]:
    all_rows: List[List[object]] = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables() or []
            for table in tables:
                for row in table:
                    if row:
                        all_rows.append([c if c is not None else "" for c in row])
    return all_rows


def parse_pdf_statement(path: Path) -> List[BankTransaction]:
    rows = _tables_to_rows(path)
    if not rows:
        return []
    hi = find_header_row(rows)
    if hi is None:
        return []
    return parse_rows_after_header(rows, hi)
