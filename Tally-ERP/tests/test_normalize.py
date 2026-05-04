import unittest
from datetime import date

from src.normalize import clean_amount, parse_date, tally_csv_date


class TestNormalize(unittest.TestCase):
    def test_clean_amount(self):
        self.assertEqual(clean_amount("1,23,456.78"), 123456.78)
        self.assertEqual(clean_amount("₹ 1000"), 1000.0)
        self.assertEqual(clean_amount("(500.00)"), -500.0)
        self.assertIsNone(clean_amount("-"))
        self.assertEqual(clean_amount(42), 42.0)

    def test_parse_date(self):
        self.assertEqual(parse_date("15/03/2025"), date(2025, 3, 15))
        self.assertEqual(parse_date("15-Mar-2025"), date(2025, 3, 15))

    def test_tally_csv_date(self):
        self.assertEqual(tally_csv_date(date(2025, 3, 15)), "15-03-2025")


if __name__ == "__main__":
    unittest.main()
