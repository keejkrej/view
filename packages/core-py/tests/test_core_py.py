from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from core_py import (  # noqa: E402
    clear_excluded_cell_ids,
    collect_edge_cell_ids,
    merge_excluded_cell_ids,
    normalize_grid_state,
    set_excluded_cell_ids_for_position,
    toggle_excluded_cell_ids,
)


class CollectEdgeCellIdsTests(unittest.TestCase):
    def test_collects_cells_touching_frame_border(self) -> None:
        edge_cell_ids = collect_edge_cell_ids(
            100,
            100,
            normalize_grid_state(
                {
                    "enabled": True,
                    "spacingA": 50,
                    "spacingB": 50,
                    "cellWidth": 50,
                    "cellHeight": 50,
                }
            ),
        )

        self.assertIn("-1:0", edge_cell_ids)
        self.assertIn("0:-1", edge_cell_ids)
        self.assertNotIn("0:0", edge_cell_ids)

    def test_exclusion_helpers_are_sorted_and_drop_empty_entries(self) -> None:
        self.assertEqual(toggle_excluded_cell_ids(["a", "b"], ["b", "c"]), ["a", "c"])
        self.assertEqual(merge_excluded_cell_ids(["b"], ["a", "b", "c"]), ["a", "b", "c"])
        state = set_excluded_cell_ids_for_position(clear_excluded_cell_ids(), 3, ["b", "a"])
        self.assertEqual(state, {3: ["a", "b"]})
        self.assertEqual(set_excluded_cell_ids_for_position(state, 3, []), {})


if __name__ == "__main__":
    unittest.main()
