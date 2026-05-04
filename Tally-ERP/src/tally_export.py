from __future__ import annotations

import csv
import io
import xml.sax.saxutils as xml_esc
from pathlib import Path
from typing import Iterable, List

from .models import BankTransaction
from .normalize import tally_csv_date


def transactions_to_tally_csv(
    rows: Iterable[BankTransaction],
    include_balance: bool = True,
) -> str:
    """
    Tally-friendly CSV: Date (DD-MM-YYYY), Narration, Withdrawal (Dr), Deposit (Cr),
    optional Closing Balance. Amounts without commas.
    """
    buf = io.StringIO()
    fieldnames = ["Date", "Narration", "Withdrawal (Dr)", "Deposit (Cr)"]
    if include_balance:
        fieldnames.append("Closing Balance")
    w = csv.DictWriter(buf, fieldnames=fieldnames, lineterminator="\n")
    w.writeheader()
    for t in rows:
        dr = "" if t.debit is None else f"{t.debit:.2f}"
        cr = "" if t.credit is None else f"{t.credit:.2f}"
        bal = ""
        if include_balance and t.balance is not None:
            bal = f"{t.balance:.2f}"
        rec = {
            "Date": tally_csv_date(t.txn_date),
            "Narration": t.narration.replace("\n", " ").strip(),
            "Withdrawal (Dr)": dr,
            "Deposit (Cr)": cr,
        }
        if include_balance:
            rec["Closing Balance"] = bal
        w.writerow(rec)
    return buf.getvalue()


def write_tally_csv(path: Path, rows: List[BankTransaction], include_balance: bool = True) -> None:
    path.write_text(transactions_to_tally_csv(rows, include_balance=include_balance), encoding="utf-8")


def transactions_to_tally_voucher_xml(
    rows: List[BankTransaction],
    *,
    voucher_type_receipt: str = "Receipt",
    voucher_type_payment: str = "Payment",
    ledger_bank: str = "Bank Statement Import",
    ledger_contra: str = "Suspense / Bank Clearing",
) -> str:
    """
    Minimal Tally XML envelope for voucher import tools.
    Maps credits → Receipt (money in), debits → Payment (money out).
    Adjust ledger names in Tally after import or change parameters.
    """
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<ENVELOPE>",
        "<BODY>",
        "<IMPORTDATA>",
        "<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>",
        "<REQUESTDATA>",
        "<TALLYMESSAGE>",
    ]
    for i, t in enumerate(rows, start=1):
        vtype = voucher_type_receipt if t.credit else voucher_type_payment
        amt = t.credit if t.credit else (t.debit or 0)
        date_str = tally_csv_date(t.txn_date)
        narr = xml_esc.escape(t.narration)
        bank = xml_esc.escape(ledger_bank)
        contra = xml_esc.escape(ledger_contra)
        lines.append(f'<VOUCHER VCHTYPE="{xml_esc.escape(vtype)}" ACTION="Create">')
        lines.append(f"<DATE>{date_str}</DATE>")
        lines.append(f"<VOUCHERTYPE>{xml_esc.escape(vtype)}</VOUCHERTYPE>")
        lines.append(f"<VOUCHERNUMBER>BNK-{i}</VOUCHERNUMBER>")
        lines.append("<ALLLEDGERENTRIES.LIST>")
        lines.append(f"<LEDGERNAME>{bank}</LEDGERNAME>")
        if t.credit:
            lines.append("<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>")
            lines.append(f"<AMOUNT>{amt:.2f}</AMOUNT>")
        else:
            lines.append("<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>")
            lines.append(f"<AMOUNT>-{amt:.2f}</AMOUNT>")
        lines.append("</ALLLEDGERENTRIES.LIST>")
        lines.append("<ALLLEDGERENTRIES.LIST>")
        lines.append(f"<LEDGERNAME>{contra}</LEDGERNAME>")
        if t.credit:
            lines.append("<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>")
            lines.append(f"<AMOUNT>-{amt:.2f}</AMOUNT>")
        else:
            lines.append("<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>")
            lines.append(f"<AMOUNT>{amt:.2f}</AMOUNT>")
        lines.append("</ALLLEDGERENTRIES.LIST>")
        lines.append(f"<NARRATION>{narr}</NARRATION>")
        lines.append("</VOUCHER>")
    lines.extend(["</TALLYMESSAGE>", "</REQUESTDATA>", "</IMPORTDATA>", "</BODY>", "</ENVELOPE>"])
    return "\n".join(lines)


def write_tally_xml(path: Path, rows: List[BankTransaction], **kwargs) -> None:
    path.write_text(transactions_to_tally_voucher_xml(rows, **kwargs), encoding="utf-8")
