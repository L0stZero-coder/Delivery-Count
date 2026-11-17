import unittest
from box_counts import count_boxes, parse_boxes
from server import grouped_history


class BoxCountingTests(unittest.TestCase):
    def test_individuals_ranges_and_lists(self):
        for label, expected in [
            ("Ki6", 1), ("GG17, GG18; GG19", 3), ("KE1-KE5", 5),
            ("R197–206", 10), ("ke1—KE5, KE3, ke5, KE6", 6),
            (" Ki 6 , ki6, KI006 ", 1), ("1-3", 3),
            ("G1~G3", 3), ("R197~206", 10), ("1~3", 3),
            ("g1 ~ G3, G2-G4", 4), ("G1～G3", 3),
        ]:
            with self.subTest(label=label):
                result = count_boxes([label])
                self.assertTrue(result["complete"])
                self.assertEqual(result["count"], expected)

    def test_shared_boxes_and_separate_deliveries(self):
        self.assertEqual(count_boxes(["Ki6", "ki6", "KE1-KE5", "ke1-5"])["count"], 6)
        self.assertEqual(count_boxes(["KE1-5"])["count"], 5)
        self.assertEqual(count_boxes(["KE1-5"])["count"], 5)

    def test_incomplete_data_never_claims_match(self):
        for label in ["", "KE5-1", "KE1-GG5", "KE1-999999999", "?", "KE1/KE2", ","]:
            with self.subTest(label=label):
                result = count_boxes(["Ki6", label], 1)
                self.assertFalse(result["complete"])
                self.assertIsNone(result["difference"])
                self.assertEqual(result["count"], 1)
        self.assertFalse(count_boxes([])["complete"])
        self.assertEqual(count_boxes(["KE1-5"], 8)["difference"], -3)
        self.assertEqual(count_boxes(["KE1-5"], 5)["difference"], 0)

    def test_quantities_and_original_labels(self):
        base = dict(status="arrived", id=1, product_id=1, arrival="2026-11-14", boxes=6,
                    name="Holder", model="Y-H107", colour="Black", barcode="00123", details="{}")
        rows = [dict(base, qty=500, box_number="KE1-KE5"),
                dict(base, qty=20, box_number="ke3"),
                dict(base, product_id=2, colour="White", qty=250, box_number="KE1-KE5"),
                dict(base, id=2, qty=10, box_number="KE1")]
        groups = grouped_history(rows)
        first = next(row for row in groups if row["id"] == 1 and row["product_id"] == 1)
        self.assertEqual(first["qty"], 520)
        self.assertEqual(first["box_quantities"], [("KE1-KE5", 500), ("ke3", 20)])
        self.assertEqual(first["product_box_count"]["count"], 5)
        self.assertEqual(sum(row["qty"] for row in groups), 780)


if __name__ == "__main__":
    unittest.main()
