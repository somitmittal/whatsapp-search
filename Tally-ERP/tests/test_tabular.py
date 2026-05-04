import unittest

from src.column_map import infer_columns
from src.parsers.tabular import find_header_row, parse_rows_after_header, row_to_transaction


class TestTabular(unittest.TestCase):
    def test_infer_columns_hdfc_style(self):
        headers = ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"]
        cmap = infer_columns(headers)
        self.assertIn("date", cmap)
        self.assertIn("narration", cmap)
        self.assertIn("debit", cmap)
        self.assertIn("credit", cmap)
        self.assertIn("balance", cmap)

    def test_find_header_and_parse(self):
        rows = [
            ["Account Statement", ""],
            ["Date", "Particulars", "Withdrawal", "Deposit", "Balance"],
            ["01/04/2025", "UPI/XXXX", "100.00", "", "9000.00"],
            ["02/04/2025", "NEFT Credit", "", "5000.00", "14000.00"],
        ]
        hi = find_header_row(rows)
        self.assertEqual(hi, 1)
        txns = parse_rows_after_header(rows, hi)
        self.assertEqual(len(txns), 2)
        self.assertEqual(txns[0].debit, 100.0)
        self.assertEqual(txns[1].credit, 5000.0)

    def test_row_single_amount_dr_cr(self):
        colmap = {"date": 0, "narration": 1, "amount": 2, "dr_cr": 3}
        t = row_to_transaction(["01/04/2025", "ATM", "200", "Dr"], colmap)
        self.assertIsNotNone(t)
        assert t is not None
        self.assertEqual(t.debit, 200.0)
        self.assertIsNone(t.credit)


if __name__ == "__main__":
    unittest.main()
