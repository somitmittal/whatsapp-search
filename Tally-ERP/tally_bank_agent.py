#!/usr/bin/env python3
"""CLI: Indian bank statements → Tally-friendly CSV/XML."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from src.agent import convert_file, parse_statement
from src.tally_export import transactions_to_tally_csv


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Convert HDFC/ICICI/PNB-style statements to Tally import format.")
    p.add_argument("input", type=Path, help="Bank statement file (PDF, CSV, XLSX)")
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Output CSV path (default: <input_stem>_tally.csv)",
    )
    p.add_argument("--xml", type=Path, default=None, help="Also write voucher XML to this path")
    p.add_argument(
        "--no-balance",
        action="store_true",
        help="Omit Closing Balance column from CSV",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse only; print bank detection and transaction count",
    )
    args = p.parse_args(argv)

    inp = args.input.expanduser().resolve()
    out = args.output or inp.with_name(f"{inp.stem}_tally.csv")

    try:
        if args.dry_run:
            r = parse_statement(inp)
            print(f"Detected bank hint: {r.bank_hint.value}")
            print(f"Transactions parsed: {len(r.transactions)}")
            if r.transactions:
                sample = r.transactions[:3]
                print(transactions_to_tally_csv(sample, include_balance=not args.no_balance))
            return 0

        r = convert_file(
            inp,
            out,
            out_xml=args.xml,
            include_balance=not args.no_balance,
        )
        print(f"Bank hint: {r.bank_hint.value}")
        print(f"Wrote {len(r.transactions)} rows → {out}")
        if args.xml:
            print(f"Wrote XML → {args.xml}")
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
