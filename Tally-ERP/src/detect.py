from __future__ import annotations

from enum import Enum
from pathlib import Path


class BankHint(str, Enum):
    HDFC = "hdfc"
    ICICI = "icici"
    PNB = "pnb"
    SBI = "sbi"
    AXIS = "axis"
    UNKNOWN = "unknown"


def _score(text: str, keywords: list[str]) -> int:
    t = text.lower()
    return sum(1 for k in keywords if k in t)


def detect_bank_from_text(snippet: str) -> BankHint:
    s = snippet[:20000].lower()
    scores = {
        BankHint.HDFC: _score(s, ["hdfc", "housing development finance"]),
        BankHint.ICICI: _score(s, ["icici", "icici bank"]),
        BankHint.PNB: _score(s, ["punjab national", "pnb", "www.pnbindia.in"]),
        BankHint.SBI: _score(s, ["state bank of india", " sbi ", "sbi.co.in"]),
        BankHint.AXIS: _score(s, ["axis bank", "axisbank"]),
    }
    best = max(scores.items(), key=lambda x: x[1])
    if best[1] == 0:
        return BankHint.UNKNOWN
    return best[0]


def sniff_headers(row_values: list[str]) -> BankHint:
    joined = " ".join(str(x or "") for x in row_values).lower()
    if "hdfc" in joined or "withdrawal amt" in joined:
        return BankHint.HDFC
    if "icici" in joined:
        return BankHint.ICICI
    if "pnb" in joined or "punjab national" in joined:
        return BankHint.PNB
    if "axis" in joined:
        return BankHint.AXIS
    if "state bank" in joined or " sbi" in joined:
        return BankHint.SBI
    return BankHint.UNKNOWN


def read_pdf_text_sample(path: Path, max_pages: int = 2) -> str:
    import pdfplumber

    parts = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages[:max_pages]:
            t = page.extract_text() or ""
            parts.append(t)
    return "\n".join(parts)


def detect_bank_from_file(path: Path) -> BankHint:
    suf = path.suffix.lower()
    if suf == ".pdf":
        try:
            return detect_bank_from_text(read_pdf_text_sample(path))
        except Exception:
            return BankHint.UNKNOWN
    if suf in (".csv", ".txt"):
        try:
            raw = path.read_text(encoding="utf-8", errors="ignore")[:15000]
            return detect_bank_from_text(raw)
        except Exception:
            return BankHint.UNKNOWN
    if suf in (".xlsx", ".xls"):
        try:
            import pandas as pd

            df = pd.read_excel(path, header=None, nrows=30, engine=None)
            text = df.astype(str).to_string()
            return detect_bank_from_text(text)
        except Exception:
            return BankHint.UNKNOWN
    return BankHint.UNKNOWN
