from __future__ import annotations

import unittest
from itertools import product
from pathlib import Path

import numpy as np

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages" / "core-py" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from view_py import native_shell  # noqa: E402


class FakeND2Handle:
    def __init__(self, sizes: dict[str, int], frames: list[np.ndarray], loop_axes: tuple[str, ...]) -> None:
        self.sizes = sizes
        self._frames = frames
        self.loop_indices = tuple(
            dict(zip(loop_axes, coords))
            for coords in product(*(range(int(sizes[axis])) for axis in loop_axes))
        )
        self.last_seq_index: int | None = None

    def read_frame(self, seq_index: int) -> np.ndarray:
        self.last_seq_index = seq_index
        return self._frames[seq_index]


class ReadND2Frame2DTests(unittest.TestCase):
    def test_reads_channel_from_frame_axes_without_using_channel_in_sequence_index(self) -> None:
        sizes = {"P": 2, "T": 2, "Z": 2, "C": 2, "Y": 3, "X": 4}
        loop_axes = ("P", "T", "Z")
        frames = [
            np.stack(
                [
                    np.full((3, 4), fill_value=seq_index, dtype=np.uint16),
                    np.full((3, 4), fill_value=seq_index + 100, dtype=np.uint16),
                ]
            )
            for seq_index in range(8)
        ]
        handle = FakeND2Handle(sizes, frames, loop_axes)

        image = native_shell.read_nd2_frame_2d(handle, p=1, t=0, c=1, z=1)

        expected_seq_index = handle.loop_indices.index({"P": 1, "T": 0, "Z": 1})
        self.assertEqual(handle.last_seq_index, expected_seq_index)
        self.assertEqual(image.shape, (3, 4))
        self.assertTrue(np.all(image == expected_seq_index + 100))

    def test_rgb_frame_is_converted_to_grayscale(self) -> None:
        sizes = {"T": 2, "Y": 2, "X": 3, "S": 3}
        loop_axes = ("T",)
        frames = [
            np.dstack(
                [
                    np.full((2, 3), fill_value=5 + seq_index, dtype=np.uint16),
                    np.full((2, 3), fill_value=15 + seq_index, dtype=np.uint16),
                    np.full((2, 3), fill_value=25 + seq_index, dtype=np.uint16),
                ]
            )
            for seq_index in range(2)
        ]
        handle = FakeND2Handle(sizes, frames, loop_axes)

        image = native_shell.read_nd2_frame_2d(handle, p=0, t=1, c=0, z=0)

        self.assertEqual(handle.last_seq_index, 1)
        self.assertEqual(image.shape, (2, 3))
        self.assertTrue(np.all(image == 16))

    def test_returned_frame_is_copied_before_reader_lifetime_ends(self) -> None:
        sizes = {"Y": 2, "X": 2}
        source = np.arange(4, dtype=np.uint16).reshape(2, 2)
        handle = FakeND2Handle(sizes, [source], ())

        image = native_shell.read_nd2_frame_2d(handle, p=0, t=0, c=0, z=0)

        self.assertFalse(np.shares_memory(image, source))
        source[:, :] = 999
        self.assertEqual(image.tolist(), [[0, 1], [2, 3]])


if __name__ == "__main__":
    unittest.main()
