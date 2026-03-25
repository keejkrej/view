from __future__ import annotations

import base64
import json
import math
import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import tifffile
from PySide6.QtCore import QObject, QSignalBlocker, Qt, QUrl, Slot
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QPushButton,
    QScrollArea,
    QSplitter,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtWebView import QWebView

VIEWPY_BRIDGE_PREFIX = "__viewpy__"
TIFF_PATTERN = re.compile(
    r"^img_channel(?P<channel>\d+)_position(?P<position>\d+)_time(?P<time>\d+)_z(?P<z>\d+)\.tiff?$",
    re.IGNORECASE,
)
SAMPLE_SIZE = 2048
MAX_GRID_RECTS = 8000


@dataclass(frozen=True)
class ParsedTiffName:
    channel: int
    position: int
    time: int
    z: int


@dataclass(frozen=True)
class GridCellRect:
    id: str
    x: float
    y: float
    width: float
    height: float


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def create_default_grid() -> dict[str, Any]:
    return {
        "enabled": False,
        "shape": "square",
        "tx": 0.0,
        "ty": 0.0,
        "rotation": 0.0,
        "spacingA": 96.0,
        "spacingB": 96.0,
        "cellWidth": 72.0,
        "cellHeight": 72.0,
        "opacity": 0.35,
    }


def normalize_grid_state(input_grid: dict[str, Any] | None = None) -> dict[str, Any]:
    base = create_default_grid()
    if input_grid is None:
        return base

    shape = str(input_grid.get("shape", base["shape"]))
    return {
        "enabled": bool(input_grid.get("enabled", base["enabled"])),
        "shape": shape if shape in {"square", "hex"} else base["shape"],
        "tx": float(input_grid.get("tx", base["tx"])),
        "ty": float(input_grid.get("ty", base["ty"])),
        "rotation": float(input_grid.get("rotation", base["rotation"])),
        "spacingA": max(1.0, float(input_grid.get("spacingA", base["spacingA"]))),
        "spacingB": max(1.0, float(input_grid.get("spacingB", base["spacingB"]))),
        "cellWidth": max(1.0, float(input_grid.get("cellWidth", base["cellWidth"]))),
        "cellHeight": max(1.0, float(input_grid.get("cellHeight", base["cellHeight"]))),
        "opacity": clamp(float(input_grid.get("opacity", base["opacity"])), 0.0, 1.0),
    }


def parse_pos_dir_name(name: str) -> int | None:
    normalized = "".join(ch for ch in name if not ch.isspace())
    if not normalized:
        return None
    lower = normalized.lower()
    for prefix in ("position", "pos"):
        if lower.startswith(prefix):
            rest = lower[len(prefix) :].lstrip("-_")
            if rest.isdigit():
                return int(rest)
    if lower.isdigit():
        return int(lower)
    return None


def parse_tiff_name(name: str) -> ParsedTiffName | None:
    match = TIFF_PATTERN.match(name)
    if not match:
        return None
    return ParsedTiffName(
        channel=int(match.group("channel")),
        position=int(match.group("position")),
        time=int(match.group("time")),
        z=int(match.group("z")),
    )


def collect_tiffs(folder: Path) -> list[tuple[Path, ParsedTiffName]]:
    collected: list[tuple[Path, ParsedTiffName]] = []
    for path in folder.rglob("*"):
        if not path.is_file():
            continue
        parsed = parse_tiff_name(path.name)
        if parsed:
            collected.append((path, parsed))
    return collected


def scan_workspace(root: str) -> dict[str, Any]:
    root_path = Path(root)
    position_dirs: list[tuple[int, Path]] = []
    for child in root_path.iterdir():
        if not child.is_dir():
            continue
        position = parse_pos_dir_name(child.name)
        if position is not None:
            position_dirs.append((position, child))
    position_dirs.sort(key=lambda item: item[0])

    positions: list[int] = []
    channels: set[int] = set()
    times: set[int] = set()
    z_slices: set[int] = set()

    for position, folder in position_dirs:
        positions.append(position)
        for _, parsed in collect_tiffs(folder):
            channels.add(parsed.channel)
            times.add(parsed.time)
            z_slices.add(parsed.z)

    return {
        "positions": positions,
        "channels": sorted(channels),
        "times": sorted(times),
        "zSlices": sorted(z_slices),
    }


def create_selection(scan: dict[str, list[int]]) -> dict[str, int] | None:
    positions = scan.get("positions", [])
    channels = scan.get("channels", [])
    times = scan.get("times", [])
    z_slices = scan.get("zSlices", [])
    if not positions or not channels or not times or not z_slices:
        return None
    return {
        "pos": positions[0],
        "channel": channels[0],
        "time": times[0],
        "z": z_slices[0],
    }


def coerce_selection(scan: dict[str, list[int]], selection: dict[str, int] | None) -> dict[str, int] | None:
    if selection is None:
        return create_selection(scan)

    positions = scan.get("positions", [])
    channels = scan.get("channels", [])
    times = scan.get("times", [])
    z_slices = scan.get("zSlices", [])
    if not positions or not channels or not times or not z_slices:
        return None

    return {
        "pos": selection["pos"] if selection["pos"] in positions else positions[0],
        "channel": selection["channel"] if selection["channel"] in channels else channels[0],
        "time": selection["time"] if selection["time"] in times else times[0],
        "z": selection["z"] if selection["z"] in z_slices else z_slices[0],
    }


def find_frame_path(root: str, request: dict[str, int]) -> Path:
    root_path = Path(root)
    for child in root_path.iterdir():
        if child.is_dir() and parse_pos_dir_name(child.name) == request["pos"]:
            for path, parsed in collect_tiffs(child):
                if (
                    parsed.position == request["pos"]
                    and parsed.channel == request["channel"]
                    and parsed.time == request["time"]
                    and parsed.z == request["z"]
                ):
                    return path
    raise FileNotFoundError("Requested TIFF frame not found")


def load_frame(root: str, request: dict[str, int]) -> tuple[int, int, np.ndarray]:
    path = find_frame_path(root, request)
    image = tifffile.imread(path)
    array = np.asarray(image)
    if array.ndim == 2:
        grayscale = array
    elif array.ndim == 3 and array.shape[-1] in (3, 4):
        grayscale = array.mean(axis=-1)
    else:
        raise ValueError("Unsupported TIFF sample layout")

    grayscale = np.clip(grayscale, 0, np.iinfo(np.uint16).max).astype(np.uint16, copy=False)
    height, width = grayscale.shape
    return width, height, grayscale


def sampled_values(values: np.ndarray) -> np.ndarray:
    flat = values.reshape(-1)
    if flat.size == 0:
        return np.array([0], dtype=np.uint16)
    if flat.size <= SAMPLE_SIZE:
        return np.sort(flat)
    indices = np.linspace(0, flat.size - 1, SAMPLE_SIZE, dtype=np.int64)
    return np.sort(flat[indices])


def percentile(values: np.ndarray, q: float) -> int:
    sorted_values = sampled_values(values)
    index = int(max(0.0, min(1.0, q)) * (sorted_values.size - 1))
    return int(sorted_values[index])


def auto_contrast(values: np.ndarray) -> dict[str, int]:
    if values.size == 0:
        return {"min": 0, "max": 1}
    minimum = percentile(values, 0.001)
    maximum = percentile(values, 0.999)
    return {"min": minimum, "max": max(minimum + 1, maximum)}


def normalize_contrast(contrast: dict[str, int] | None) -> dict[str, int]:
    if contrast is None:
        raise ValueError("contrast window is required")
    minimum = max(0, min(int(contrast["min"]), np.iinfo(np.uint16).max - 1))
    maximum = max(minimum + 1, min(int(contrast["max"]), np.iinfo(np.uint16).max))
    return {"min": minimum, "max": maximum}


def apply_contrast(values: np.ndarray, contrast: dict[str, int]) -> np.ndarray:
    minimum = float(contrast["min"])
    maximum = float(max(contrast["max"], contrast["min"] + 1))
    normalized = np.clip((values.astype(np.float32) - minimum) / max(1.0, maximum - minimum), 0.0, 1.0)
    return np.round(normalized * 255.0).astype(np.uint8)


def save_bbox(root: str, pos: int, csv: str) -> dict[str, Any]:
    root_path = Path(root)
    root_path.mkdir(parents=True, exist_ok=True)
    payload = csv if csv.endswith("\n") else f"{csv}\n"
    try:
        (root_path / f"Pos{pos}_bbox.csv").write_text(payload, encoding="utf-8")
        return {"ok": True}
    except OSError as error:
        return {"ok": False, "error": str(error)}


def grid_basis(shape: str, rotation: float, spacing_a: float, spacing_b: float) -> tuple[tuple[float, float], tuple[float, float]]:
    second_angle = rotation + (math.pi / 2 if shape == "square" else math.pi / 3)
    return (
        (math.cos(rotation) * spacing_a, math.sin(rotation) * spacing_a),
        (math.cos(second_angle) * spacing_b, math.sin(second_angle) * spacing_b),
    )


def estimate_grid_draw(width: int, height: int, spacing_a: float, spacing_b: float, max_rects: int = MAX_GRID_RECTS) -> tuple[int, int]:
    min_spacing = max(1.0, min(spacing_a, spacing_b))
    max_dim = max(width, height) * 2
    value_range = math.ceil(max_dim / min_spacing) + 2
    estimated = (value_range * 2 + 1) ** 2
    stride = math.ceil(math.sqrt(estimated / max_rects)) if estimated > max_rects else 1
    return value_range, stride


def enumerate_visible_grid_cells(frame_width: int, frame_height: int, grid: dict[str, Any]) -> list[GridCellRect]:
    value_range, stride = estimate_grid_draw(frame_width, frame_height, grid["spacingA"], grid["spacingB"])
    (ax, ay), (bx, by) = grid_basis(
        grid["shape"],
        grid["rotation"],
        grid["spacingA"],
        grid["spacingB"],
    )
    origin_x = frame_width / 2 + grid["tx"]
    origin_y = frame_height / 2 + grid["ty"]
    half_width = grid["cellWidth"] / 2
    half_height = grid["cellHeight"] / 2
    cells: list[GridCellRect] = []

    for i in range(-value_range, value_range + 1, stride):
        for j in range(-value_range, value_range + 1, stride):
            center_x = origin_x + i * ax + j * bx
            center_y = origin_y + i * ay + j * by
            cell = GridCellRect(
                id=f"{i}:{j}",
                x=center_x - half_width,
                y=center_y - half_height,
                width=grid["cellWidth"],
                height=grid["cellHeight"],
            )
            if (
                cell.x + cell.width >= 0
                and cell.y + cell.height >= 0
                and cell.x <= frame_width
                and cell.y <= frame_height
            ):
                cells.append(cell)

    return cells


def build_bbox_csv(frame_width: int, frame_height: int, grid: dict[str, Any], excluded_cell_ids: set[str]) -> str:
    rows = ["crop,x,y,w,h"]
    crop = 0
    for cell in enumerate_visible_grid_cells(frame_width, frame_height, grid):
        if cell.id in excluded_cell_ids:
            continue

        clipped_x = int(clamp(round(cell.x), 0, frame_width))
        clipped_y = int(clamp(round(cell.y), 0, frame_height))
        clipped_right = int(clamp(round(cell.x + cell.width), 0, frame_width))
        clipped_bottom = int(clamp(round(cell.y + cell.height), 0, frame_height))
        clipped_width = clipped_right - clipped_x
        clipped_height = clipped_bottom - clipped_y
        if clipped_width <= 0 or clipped_height <= 0:
            continue

        rows.append(f"{crop},{clipped_x},{clipped_y},{clipped_width},{clipped_height}")
        crop += 1

    return "\n".join(rows)


def count_visible_cells(frame_width: int, frame_height: int, grid: dict[str, Any], excluded_cell_ids: set[str]) -> tuple[int, int]:
    cells = enumerate_visible_grid_cells(frame_width, frame_height, grid)
    excluded_count = sum(1 for cell in cells if cell.id in excluded_cell_ids)
    return len(cells) - excluded_count, excluded_count


class LocalBackend:
    def scan_workspace(self, root: str) -> dict[str, Any]:
        return scan_workspace(root)

    def load_frame(
        self,
        root: str,
        request: dict[str, int],
        contrast: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        width, height, frame = load_frame(root, request)
        suggested = auto_contrast(frame)
        applied = normalize_contrast(contrast or suggested)
        display = apply_contrast(frame, applied)
        return {
            "width": width,
            "height": height,
            "dataBase64": base64.b64encode(display.tobytes()).decode("ascii"),
            "pixelType": "uint8",
            "contrastDomain": {"min": 0, "max": int(np.iinfo(np.uint16).max)},
            "suggestedContrast": suggested,
            "appliedContrast": applied,
        }

    def save_bbox(self, root: str, pos: int, csv: str) -> dict[str, Any]:
        return save_bbox(root, pos, csv)


class ViewerMainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self._backend = LocalBackend()
        self._root = ""
        self._scan: dict[str, list[int]] | None = None
        self._selection: dict[str, int] | None = None
        self._grid = create_default_grid()
        self._frame_payload: dict[str, Any] | None = None
        self._contrast_mode = "auto"
        self._contrast_domain = {"min": 0, "max": 65535}
        self._contrast_min = 0
        self._contrast_max = 255
        self._selection_mode = False
        self._excluded_cell_ids_by_position: dict[int, set[str]] = {}
        self._error_message: str | None = None
        self._save_message: tuple[str, str] | None = None
        self._loading = False
        self._canvas_ready = False

        self.setWindowTitle("Pos Viewer (PySide6)")
        self.resize(1480, 980)
        self._build_ui()
        self._sync_ui()
        self._publish_canvas_state()

    def _build_ui(self) -> None:
        central = QWidget()
        root_layout = QVBoxLayout(central)
        root_layout.setContentsMargins(12, 12, 12, 12)
        root_layout.setSpacing(12)

        header_layout = QHBoxLayout()
        header_layout.setContentsMargins(0, 0, 0, 0)
        header_layout.setSpacing(8)

        self.open_button = QPushButton("Open Workspace")
        self.open_button.clicked.connect(self.open_workspace)
        self.clear_button = QPushButton("Clear")
        self.clear_button.clicked.connect(self.clear_workspace)
        self.root_label = QLabel("No workspace selected")
        self.root_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.root_label.setAlignment(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft)

        header_layout.addWidget(self.open_button)
        header_layout.addWidget(self.clear_button)
        header_layout.addWidget(self.root_label, 1)
        root_layout.addLayout(header_layout)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self._build_left_panel())
        splitter.addWidget(self._build_canvas_panel())
        splitter.addWidget(self._build_right_panel())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 0)
        splitter.setSizes([280, 920, 320])
        root_layout.addWidget(splitter, 1)

        self.setCentralWidget(central)

    def _build_left_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(12)

        image_group = QGroupBox("Image")
        image_form = QFormLayout(image_group)
        self.position_combo = QComboBox()
        self.position_combo.currentIndexChanged.connect(self._on_position_changed)
        self.channel_combo = QComboBox()
        self.channel_combo.currentIndexChanged.connect(self._on_channel_changed)
        self.time_combo = QComboBox()
        self.time_combo.currentIndexChanged.connect(self._on_time_changed)
        self.z_combo = QComboBox()
        self.z_combo.currentIndexChanged.connect(self._on_z_changed)
        image_form.addRow("Position", self.position_combo)
        image_form.addRow("Channel", self.channel_combo)
        image_form.addRow("Time", self.time_combo)
        image_form.addRow("Z Slice", self.z_combo)
        layout.addWidget(image_group)

        contrast_group = QGroupBox("Contrast")
        contrast_layout = QVBoxLayout(contrast_group)
        contrast_layout.setContentsMargins(12, 12, 12, 12)
        contrast_layout.setSpacing(8)
        self.auto_contrast_button = QPushButton("Auto")
        self.auto_contrast_button.clicked.connect(self._on_auto_contrast)
        contrast_layout.addWidget(self.auto_contrast_button)

        contrast_form = QFormLayout()
        self.contrast_min_spin = self._create_double_spin(0.0, 65535.0, 1.0, 0)
        self.contrast_min_spin.valueChanged.connect(self._on_contrast_changed)
        self.contrast_max_spin = self._create_double_spin(1.0, 65535.0, 1.0, 0)
        self.contrast_max_spin.valueChanged.connect(self._on_contrast_changed)
        contrast_form.addRow("Minimum", self.contrast_min_spin)
        contrast_form.addRow("Maximum", self.contrast_max_spin)
        contrast_layout.addLayout(contrast_form)
        layout.addWidget(contrast_group)
        layout.addStretch(1)

        return self._wrap_panel(panel, 280)

    def _build_canvas_panel(self) -> QWidget:
        self.view = QWebView()
        self.view.titleChanged.connect(self._on_canvas_title_changed)
        self._canvas_ready = False
        container = QWidget.createWindowContainer(self.view)
        container.setMinimumSize(320, 240)
        return container

    def _build_right_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(12)

        grid_group = QGroupBox("Grid")
        grid_layout = QVBoxLayout(grid_group)
        grid_layout.setContentsMargins(12, 12, 12, 12)
        grid_layout.setSpacing(8)

        grid_actions = QHBoxLayout()
        self.grid_reset_button = QPushButton("Reset")
        self.grid_reset_button.clicked.connect(self._on_grid_reset)
        self.grid_enabled_checkbox = QCheckBox("Enabled")
        self.grid_enabled_checkbox.toggled.connect(self._on_grid_enabled_toggled)
        grid_actions.addWidget(self.grid_reset_button)
        grid_actions.addStretch(1)
        grid_actions.addWidget(self.grid_enabled_checkbox)
        grid_layout.addLayout(grid_actions)

        grid_form = QFormLayout()
        self.grid_shape_combo = QComboBox()
        self.grid_shape_combo.addItem("Square", "square")
        self.grid_shape_combo.addItem("Hex", "hex")
        self.grid_shape_combo.currentIndexChanged.connect(self._on_grid_shape_changed)
        self.grid_rotation_spin = self._create_double_spin(-180.0, 180.0, 0.1, 1)
        self.grid_rotation_spin.valueChanged.connect(self._on_grid_rotation_changed)
        self.grid_spacing_a_spin = self._create_double_spin(1.0, 10000.0, 0.5, 2)
        self.grid_spacing_a_spin.valueChanged.connect(self._on_grid_spacing_changed)
        self.grid_spacing_b_spin = self._create_double_spin(1.0, 10000.0, 0.5, 2)
        self.grid_spacing_b_spin.valueChanged.connect(self._on_grid_spacing_changed)
        self.grid_cell_width_spin = self._create_double_spin(1.0, 10000.0, 0.5, 2)
        self.grid_cell_width_spin.valueChanged.connect(self._on_grid_cell_size_changed)
        self.grid_cell_height_spin = self._create_double_spin(1.0, 10000.0, 0.5, 2)
        self.grid_cell_height_spin.valueChanged.connect(self._on_grid_cell_size_changed)
        self.grid_tx_spin = self._create_double_spin(-100000.0, 100000.0, 0.5, 2)
        self.grid_tx_spin.valueChanged.connect(self._on_grid_offset_changed)
        self.grid_ty_spin = self._create_double_spin(-100000.0, 100000.0, 0.5, 2)
        self.grid_ty_spin.valueChanged.connect(self._on_grid_offset_changed)
        self.grid_opacity_spin = self._create_double_spin(0.0, 1.0, 0.01, 2)
        self.grid_opacity_spin.valueChanged.connect(self._on_grid_opacity_changed)
        grid_form.addRow("Shape", self.grid_shape_combo)
        grid_form.addRow("Rotation", self.grid_rotation_spin)
        grid_form.addRow("Spacing A", self.grid_spacing_a_spin)
        grid_form.addRow("Spacing B", self.grid_spacing_b_spin)
        grid_form.addRow("Cell Width", self.grid_cell_width_spin)
        grid_form.addRow("Cell Height", self.grid_cell_height_spin)
        grid_form.addRow("Offset X", self.grid_tx_spin)
        grid_form.addRow("Offset Y", self.grid_ty_spin)
        grid_form.addRow("Opacity", self.grid_opacity_spin)
        grid_layout.addLayout(grid_form)
        layout.addWidget(grid_group)

        select_group = QGroupBox("Select")
        select_layout = QVBoxLayout(select_group)
        select_layout.setContentsMargins(12, 12, 12, 12)
        select_layout.setSpacing(8)
        select_actions = QHBoxLayout()
        self.save_button = QPushButton("Save")
        self.save_button.clicked.connect(self.save_current_bbox)
        self.selection_mode_checkbox = QCheckBox("Selection Mode")
        self.selection_mode_checkbox.toggled.connect(self._on_selection_mode_toggled)
        select_actions.addWidget(self.save_button)
        select_actions.addStretch(1)
        select_actions.addWidget(self.selection_mode_checkbox)
        select_layout.addLayout(select_actions)

        counts_form = QFormLayout()
        self.included_count_label = QLabel("0")
        self.excluded_count_label = QLabel("0")
        counts_form.addRow("Included", self.included_count_label)
        counts_form.addRow("Excluded", self.excluded_count_label)
        select_layout.addLayout(counts_form)
        layout.addWidget(select_group)
        layout.addStretch(1)

        return self._wrap_panel(panel, 320)

    def _create_double_spin(
        self,
        minimum: float,
        maximum: float,
        step: float,
        decimals: int,
    ) -> QDoubleSpinBox:
        spin = QDoubleSpinBox()
        spin.setRange(minimum, maximum)
        spin.setSingleStep(step)
        spin.setDecimals(decimals)
        spin.setKeyboardTracking(False)
        return spin

    def _wrap_panel(self, widget: QWidget, width: int) -> QWidget:
        area = QScrollArea()
        area.setWidgetResizable(True)
        area.setMinimumWidth(width)
        area.setWidget(widget)
        return area

    def _with_wait_cursor(self, callback: Callable[..., Any], *args: Any) -> Any:
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            return callback(*args)
        finally:
            QApplication.restoreOverrideCursor()

    def _active_excluded_cell_ids(self) -> set[str]:
        if not self._selection:
            return set()
        return set(self._excluded_cell_ids_by_position.get(self._selection["pos"], set()))

    def _frame_size(self) -> tuple[int, int] | None:
        if not self._frame_payload:
            return None
        return int(self._frame_payload["width"]), int(self._frame_payload["height"])

    def _empty_text(self) -> str:
        if not self._root:
            return "Open a workspace to load frames"
        if self._loading and self._frame_payload is None:
            return "Loading frame..."
        if self._scan is not None and not self._selection:
            return "No frames found in workspace"
        return "No frame loaded"

    def _canvas_messages(self) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = []
        if self._error_message:
            messages.append({"tone": "error", "text": self._error_message})
        if self._save_message:
            tone, text = self._save_message
            messages.append({"tone": tone, "text": text})
        return messages

    def _publish_canvas_state(self) -> None:
        if not self._canvas_ready:
            return
        payload = {
            "frame": self._frame_payload,
            "grid": self._grid,
            "excludedCellIds": sorted(self._active_excluded_cell_ids()),
            "selectionMode": self._selection_mode,
            "loading": self._loading,
            "emptyText": self._empty_text(),
            "messages": self._canvas_messages(),
        }
        self.view.page().runJavaScript(f"window.__viewPyApplyState?.({json.dumps(payload)});")

    def _sync_root_label(self) -> None:
        self.root_label.setText(self._root or "No workspace selected")
        self.clear_button.setEnabled(bool(self._root))

    def _set_combo_items(self, combo: QComboBox, values: list[int], current: int | None) -> None:
        blocker = QSignalBlocker(combo)
        combo.clear()
        for value in values:
            combo.addItem(str(value), value)
        if current is not None:
            index = combo.findData(current)
            if index >= 0:
                combo.setCurrentIndex(index)
        del blocker

    def _sync_selection_controls(self) -> None:
        scan = self._scan or {"positions": [], "channels": [], "times": [], "zSlices": []}
        self._set_combo_items(self.position_combo, list(scan.get("positions", [])), self._selection["pos"] if self._selection else None)
        self._set_combo_items(self.channel_combo, list(scan.get("channels", [])), self._selection["channel"] if self._selection else None)
        self._set_combo_items(self.time_combo, list(scan.get("times", [])), self._selection["time"] if self._selection else None)
        self._set_combo_items(self.z_combo, list(scan.get("zSlices", [])), self._selection["z"] if self._selection else None)

    def _sync_contrast_controls(self) -> None:
        minimum = float(self._contrast_domain["min"])
        maximum = float(self._contrast_domain["max"])
        min_upper = max(minimum, maximum - 1)
        max_lower = min(maximum, minimum + 1)
        blockers = [QSignalBlocker(self.contrast_min_spin), QSignalBlocker(self.contrast_max_spin)]
        self.contrast_min_spin.setRange(minimum, min_upper)
        self.contrast_max_spin.setRange(max_lower, maximum)
        self.contrast_min_spin.setValue(float(self._contrast_min))
        self.contrast_max_spin.setValue(float(self._contrast_max))
        del blockers

    def _sync_grid_controls(self) -> None:
        blockers = [
            QSignalBlocker(self.grid_enabled_checkbox),
            QSignalBlocker(self.grid_shape_combo),
            QSignalBlocker(self.grid_rotation_spin),
            QSignalBlocker(self.grid_spacing_a_spin),
            QSignalBlocker(self.grid_spacing_b_spin),
            QSignalBlocker(self.grid_cell_width_spin),
            QSignalBlocker(self.grid_cell_height_spin),
            QSignalBlocker(self.grid_tx_spin),
            QSignalBlocker(self.grid_ty_spin),
            QSignalBlocker(self.grid_opacity_spin),
        ]
        self.grid_enabled_checkbox.setChecked(bool(self._grid["enabled"]))
        self.grid_shape_combo.setCurrentIndex(0 if self._grid["shape"] == "square" else 1)
        self.grid_rotation_spin.setValue(math.degrees(float(self._grid["rotation"])))
        self.grid_spacing_a_spin.setValue(float(self._grid["spacingA"]))
        self.grid_spacing_b_spin.setValue(float(self._grid["spacingB"]))
        self.grid_cell_width_spin.setValue(float(self._grid["cellWidth"]))
        self.grid_cell_height_spin.setValue(float(self._grid["cellHeight"]))
        self.grid_tx_spin.setValue(float(self._grid["tx"]))
        self.grid_ty_spin.setValue(float(self._grid["ty"]))
        self.grid_opacity_spin.setValue(float(self._grid["opacity"]))
        del blockers

    def _refresh_counts(self) -> None:
        frame_size = self._frame_size()
        if not frame_size:
            self.included_count_label.setText("0")
            self.excluded_count_label.setText("0")
            return

        included, excluded = count_visible_cells(
            frame_size[0],
            frame_size[1],
            self._grid,
            self._active_excluded_cell_ids(),
        )
        self.included_count_label.setText(str(included))
        self.excluded_count_label.setText(str(excluded))

    def _refresh_control_states(self) -> None:
        has_selection = self._selection is not None
        has_frame = self._frame_payload is not None
        grid_controls_enabled = has_selection

        self.position_combo.setEnabled(has_selection)
        self.channel_combo.setEnabled(has_selection)
        self.time_combo.setEnabled(has_selection)
        self.z_combo.setEnabled(has_selection)
        self.auto_contrast_button.setEnabled(has_frame)
        self.contrast_min_spin.setEnabled(has_frame)
        self.contrast_max_spin.setEnabled(has_frame)
        self.grid_reset_button.setEnabled(grid_controls_enabled)
        self.grid_enabled_checkbox.setEnabled(grid_controls_enabled)
        self.grid_shape_combo.setEnabled(grid_controls_enabled)
        self.grid_rotation_spin.setEnabled(grid_controls_enabled)
        self.grid_spacing_a_spin.setEnabled(grid_controls_enabled)
        self.grid_spacing_b_spin.setEnabled(grid_controls_enabled)
        self.grid_cell_width_spin.setEnabled(grid_controls_enabled)
        self.grid_cell_height_spin.setEnabled(grid_controls_enabled)
        self.grid_tx_spin.setEnabled(grid_controls_enabled)
        self.grid_ty_spin.setEnabled(grid_controls_enabled)
        self.grid_opacity_spin.setEnabled(grid_controls_enabled)
        selection_enabled = has_frame and bool(self._grid["enabled"])
        self.selection_mode_checkbox.setEnabled(selection_enabled)
        self.save_button.setEnabled(has_frame and has_selection)
        if not selection_enabled and self._selection_mode:
            self._selection_mode = False
        blocker = QSignalBlocker(self.selection_mode_checkbox)
        self.selection_mode_checkbox.setChecked(self._selection_mode)
        del blocker

    def _sync_ui(self) -> None:
        self._sync_root_label()
        self._sync_selection_controls()
        self._sync_contrast_controls()
        self._sync_grid_controls()
        self._refresh_counts()
        self._refresh_control_states()

    def _set_error(self, message: str | None) -> None:
        self._error_message = message

    def _clear_save_message(self) -> None:
        self._save_message = None

    def _set_workspace_state(self, root: str) -> None:
        self._root = root
        self._scan = None
        self._selection = None
        self._frame_payload = None
        self._contrast_mode = "auto"
        self._contrast_domain = {"min": 0, "max": 65535}
        self._contrast_min = 0
        self._contrast_max = 255
        self._selection_mode = False
        self._excluded_cell_ids_by_position = {}
        self._set_error(None)
        self._clear_save_message()

    def open_workspace(self, *_args: Any) -> None:
        selected = QFileDialog.getExistingDirectory(self, "Open Workspace")
        if not selected:
            return

        self._set_workspace_state(selected)
        self._loading = True
        self._sync_ui()
        self._publish_canvas_state()
        try:
            scan = self._with_wait_cursor(self._backend.scan_workspace, selected)
            self._scan = {
                "positions": [int(value) for value in scan.get("positions", [])],
                "channels": [int(value) for value in scan.get("channels", [])],
                "times": [int(value) for value in scan.get("times", [])],
                "zSlices": [int(value) for value in scan.get("zSlices", [])],
            }
            self._selection = create_selection(self._scan)
            self._set_error(None)
        except Exception as error:  # noqa: BLE001
            self._scan = None
            self._selection = None
            self._frame_payload = None
            self._set_error(str(error))
        finally:
            self._loading = False

        self._sync_ui()
        self._publish_canvas_state()
        if self._selection:
            self.load_current_frame()

    def clear_workspace(self, *_args: Any) -> None:
        self._set_workspace_state("")
        self._loading = False
        self._sync_ui()
        self._publish_canvas_state()

    def load_current_frame(self) -> None:
        if not self._root or not self._selection:
            self._frame_payload = None
            self._sync_ui()
            self._publish_canvas_state()
            return

        requested_contrast = None
        if self._contrast_mode == "manual":
            requested_contrast = {"min": int(self._contrast_min), "max": int(self._contrast_max)}

        self._loading = True
        self._clear_save_message()
        self._sync_ui()
        self._publish_canvas_state()
        try:
            payload = self._with_wait_cursor(self._backend.load_frame, self._root, self._selection, requested_contrast)
            self._frame_payload = payload
            self._contrast_domain = dict(payload.get("contrastDomain") or {"min": 0, "max": 255})
            applied = dict(payload.get("appliedContrast") or payload.get("suggestedContrast") or self._contrast_domain)
            self._contrast_min = int(
                clamp(
                    applied["min"],
                    self._contrast_domain["min"],
                    max(self._contrast_domain["min"], self._contrast_domain["max"] - 1),
                )
            )
            self._contrast_max = int(
                clamp(
                    applied["max"],
                    min(self._contrast_domain["min"] + 1, self._contrast_domain["max"]),
                    self._contrast_domain["max"],
                )
            )
            self._set_error(None)
        except Exception as error:  # noqa: BLE001
            self._frame_payload = None
            self._set_error(str(error))
        finally:
            self._loading = False

        self._sync_ui()
        self._publish_canvas_state()

    def save_current_bbox(self, *_args: Any) -> None:
        frame_size = self._frame_size()
        if not self._root or not self._selection or not frame_size:
            return

        csv = build_bbox_csv(frame_size[0], frame_size[1], self._grid, self._active_excluded_cell_ids())
        try:
            response = self._with_wait_cursor(self._backend.save_bbox, self._root, int(self._selection["pos"]), csv)
            if response.get("ok"):
                self._save_message = ("success", f"Saved Pos{self._selection['pos']}_bbox.csv")
                self._set_error(None)
            else:
                self._save_message = ("error", str(response.get("error", "Failed to save bbox CSV")))
        except Exception as error:  # noqa: BLE001
            self._save_message = ("error", str(error))

        self._sync_ui()
        self._publish_canvas_state()

    def _set_selection_key(self, key: str, value: int) -> None:
        if not self._scan:
            return
        next_selection = dict(self._selection or create_selection(self._scan) or {})
        if not next_selection:
            return
        next_selection[key] = int(value)
        coerced = coerce_selection(self._scan, next_selection)
        if coerced == self._selection:
            return
        self._selection = coerced
        self._frame_payload = None
        self._selection_mode = False
        self._clear_save_message()
        self._sync_ui()
        self._publish_canvas_state()
        self.load_current_frame()

    def _update_grid(self, patch: dict[str, Any]) -> None:
        next_grid = normalize_grid_state({**self._grid, **patch})
        if next_grid == self._grid:
            return
        self._grid = next_grid
        if not self._grid["enabled"]:
            self._selection_mode = False
        self._clear_save_message()
        self._sync_ui()
        self._publish_canvas_state()

    def _on_position_changed(self, *_args: Any) -> None:
        value = self.position_combo.currentData()
        if value is not None:
            self._set_selection_key("pos", int(value))

    def _on_channel_changed(self, *_args: Any) -> None:
        value = self.channel_combo.currentData()
        if value is not None:
            self._set_selection_key("channel", int(value))

    def _on_time_changed(self, *_args: Any) -> None:
        value = self.time_combo.currentData()
        if value is not None:
            self._set_selection_key("time", int(value))

    def _on_z_changed(self, *_args: Any) -> None:
        value = self.z_combo.currentData()
        if value is not None:
            self._set_selection_key("z", int(value))

    def _on_auto_contrast(self, *_args: Any) -> None:
        if not self._selection:
            return
        self._contrast_mode = "auto"
        self.load_current_frame()

    def _on_contrast_changed(self, *_args: Any) -> None:
        if not self._frame_payload:
            return
        minimum = int(self.contrast_min_spin.value())
        maximum = int(self.contrast_max_spin.value())
        if minimum >= maximum:
            if self.sender() is self.contrast_min_spin:
                minimum = maximum - 1
            else:
                maximum = minimum + 1
        self._contrast_mode = "manual"
        self._contrast_min = int(
            clamp(
                minimum,
                self._contrast_domain["min"],
                max(self._contrast_domain["min"], self._contrast_domain["max"] - 1),
            )
        )
        self._contrast_max = int(
            clamp(
                maximum,
                min(self._contrast_domain["min"] + 1, self._contrast_domain["max"]),
                self._contrast_domain["max"],
            )
        )
        self.load_current_frame()

    def _on_grid_reset(self, *_args: Any) -> None:
        self._update_grid({**create_default_grid(), "enabled": self._grid["enabled"]})

    def _on_grid_enabled_toggled(self, checked: bool) -> None:
        self._update_grid({"enabled": checked})

    def _on_grid_shape_changed(self, *_args: Any) -> None:
        value = self.grid_shape_combo.currentData()
        if value is not None:
            self._update_grid({"shape": str(value)})

    def _on_grid_rotation_changed(self, *_args: Any) -> None:
        self._update_grid({"rotation": math.radians(self.grid_rotation_spin.value())})

    def _on_grid_spacing_changed(self, *_args: Any) -> None:
        self._update_grid({"spacingA": self.grid_spacing_a_spin.value(), "spacingB": self.grid_spacing_b_spin.value()})

    def _on_grid_cell_size_changed(self, *_args: Any) -> None:
        self._update_grid({"cellWidth": self.grid_cell_width_spin.value(), "cellHeight": self.grid_cell_height_spin.value()})

    def _on_grid_offset_changed(self, *_args: Any) -> None:
        self._update_grid({"tx": self.grid_tx_spin.value(), "ty": self.grid_ty_spin.value()})

    def _on_grid_opacity_changed(self, *_args: Any) -> None:
        self._update_grid({"opacity": self.grid_opacity_spin.value()})

    def _on_selection_mode_toggled(self, checked: bool) -> None:
        enabled = bool(checked and self._frame_payload and self._grid["enabled"])
        if enabled == self._selection_mode:
            return
        self._selection_mode = enabled
        self._publish_canvas_state()

    def handle_canvas_ready(self) -> None:
        self._canvas_ready = True
        self._publish_canvas_state()

    def _on_canvas_title_changed(self, title: str) -> None:
        if not title.startswith(VIEWPY_BRIDGE_PREFIX):
            return
        try:
            envelope = json.loads(title[len(VIEWPY_BRIDGE_PREFIX) :])
        except json.JSONDecodeError:
            return

        if not isinstance(envelope, dict):
            return
        message_type = envelope.get("type")
        payload = envelope.get("payload")

        if message_type == "ready":
            self.handle_canvas_ready()
            return
        if message_type == "gridChanged":
            self.handle_canvas_grid_changed(payload)
            return
        if message_type == "excludedCellsAdded":
            self.handle_canvas_excluded_cells_added(payload)

    def handle_canvas_grid_changed(self, payload: Any) -> None:
        self._grid = normalize_grid_state(payload if isinstance(payload, dict) else None)
        if not self._grid["enabled"]:
            self._selection_mode = False
        self._clear_save_message()
        self._sync_ui()

    def handle_canvas_excluded_cells_added(self, payload: Any) -> None:
        if not self._selection:
            return
        if not isinstance(payload, list):
            return

        position = int(self._selection["pos"])
        active = set(self._excluded_cell_ids_by_position.get(position, set()))
        changed = False
        for cell_id in payload:
            if isinstance(cell_id, str) and cell_id not in active:
                active.add(cell_id)
                changed = True

        if not changed:
            return
        self._excluded_cell_ids_by_position[position] = active
        self._clear_save_message()
        self._refresh_counts()


def resolve_frontend_url() -> tuple[QUrl, Callable[[], None] | None]:
    env_url = os.getenv("VIEW_PYSIDE6_URL")
    if env_url:
        return QUrl(env_url), None

    dist_index = Path(__file__).resolve().parent.parent / "web" / "dist" / "index.html"
    if dist_index.exists():
        return QUrl.fromLocalFile(str(dist_index.resolve())), None

    return QUrl("http://127.0.0.1:5174"), None


def main() -> int:
    app = QApplication(sys.argv)
    frontend_url, stop_frontend_server = resolve_frontend_url()
    try:
        window = ViewerMainWindow()
        window.view.setUrl(frontend_url)
        window.show()
        return app.exec()
    finally:
        if stop_frontend_server is not None:
            stop_frontend_server()
