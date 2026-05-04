from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from .detect import BankHint, detect_bank_from_file
from .models import BankTransaction
from .parsers import parse_csv_or_excel, parse_pdf_statement
from .tally_export import write_tally_csv, write_tally_xml


@dataclass
class ConversionResult:
    bank_hint: BankHint
    transactions: List[BankTransaction]
    source_path: Path


def parse_statement(path: Path) -> ConversionResult:
    path = path.expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(str(path))

    bank = detect_bank_from_file(path)
    suf = path.suffix.lower()

    if suf == ".pdf":
        txns = parse_pdf_statement(path)
    elif suf in (".csv", ".xlsx", ".xls"):
        txns = parse_csv_or_excel(path)
    else:
        raise ValueError(f"Unsupported file type: {suf}. Use PDF, CSV, or Excel.")

    txns.sort(key=lambda t: t.txn_date)
    return ConversionResult(bank_hint=bank, transactions=txns, source_path=path)


def export_for_tally(
    result: ConversionResult,
    out_csv: Path,
    out_xml: Optional[Path] = None,
    *,
    include_balance: bool = True,
    xml_kwargs: Optional[dict] = None,
) -> None:
    if not result.transactions:
        raise ValueError("No transactions parsed; check statement layout or export format.")
    write_tally_csv(out_csv, result.transactions, include_balance=include_balance)
    if out_xml:
        write_tally_xml(out_xml, result.transactions, **(xml_kwargs or {}))


def convert_file(
    input_path: Path,
    out_csv: Path,
    out_xml: Optional[Path] = None,
    **kwargs,
) -> ConversionResult:
    result = parse_statement(input_path)
    export_for_tally(result, out_csv, out_xml, **kwargs)
    return result
