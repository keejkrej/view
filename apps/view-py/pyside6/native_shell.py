from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import re
import sys
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import tifffile
from PySide6.QtCore import QObject, QSignalBlocker, Qt, QUrl, Slot
from PySide6.QtGui import QDoubleValidator, QIcon
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QPushButton,
    QSlider,
    QSplitter,
    QVBoxLayout,
    QWidget,
)
from websockets.asyncio.server import serve
from core_py import (
    ExcludedCellIdsByPosition,
    GridCellRect,
    build_bbox_csv,
    clear_excluded_cell_ids,
    collect_edge_cell_ids,
    count_visible_cells,
    create_default_grid,
    merge_excluded_cell_ids,
    minimum_grid_spacing,
    normalize_grid_state,
    set_excluded_cell_ids_for_position,
    toggle_excluded_cell_ids,
)

TIFF_PATTERN = re.compile(
    r"^img_channel(?P<channel>\d+)_position(?P<position>\d+)_time(?P<time>\d+)_z(?P<z>\d+)\.tiff?$",
    re.IGNORECASE,
)
SAMPLE_SIZE = 2048
BACKEND_HOST = "127.0.0.1"
HERE = Path(__file__).resolve().parent
ICON_PATH = HERE / "icons" / "icon.png"


@dataclass(frozen=True)
class ParsedTiffName:
    channel: int
    position: int
    time: int
    z: int


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


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


def normalize_source(source: Any) -> dict[str, str]:
    if not isinstance(source, dict):
        raise ValueError("Invalid source payload")
    kind = source.get("kind")
    path = source.get("path")
    if kind not in {"tif", "nd2"} or not isinstance(path, str) or not path:
        raise ValueError("Invalid source payload")
    return {"kind": kind, "path": path}


def nd2_dimension_size(sizes: dict[str, int], key: str) -> int:
    return int(sizes.get(key, 1))


def nd2_dimension_values(sizes: dict[str, int], key: str) -> list[int]:
    return list(range(nd2_dimension_size(sizes, key)))


def nd2_loop_index(handle: Any, p: int, t: int, z: int) -> int:
    loop_indices = tuple(getattr(handle, "loop_indices", ()) or ())
    if not loop_indices:
        return 0
    for seq_index, indices in enumerate(loop_indices):
        if (
            int(indices.get("P", 0)) == p
            and int(indices.get("T", 0)) == t
            and int(indices.get("Z", 0)) == z
        ):
            return seq_index
    raise ValueError("Requested ND2 frame not found")


def nd2_frame_axes(sizes: dict[str, int]) -> list[str]:
    return [dimension for dimension in sizes.keys() if dimension in {"C", "Y", "X", "S"}]


def nd2_frame_to_grayscale(frame: np.ndarray, sizes: dict[str, int], channel: int) -> np.ndarray:
    grayscale = np.asarray(frame)
    active_axes = [axis for axis in nd2_frame_axes(sizes) if nd2_dimension_size(sizes, axis) > 1]

    if grayscale.ndim != len(active_axes):
        if grayscale.ndim == 2:
            active_axes = ["Y", "X"]
        else:
            raise ValueError("Unsupported ND2 frame layout")

    if "C" in active_axes:
        channel_axis = active_axes.index("C")
        if channel < 0 or channel >= grayscale.shape[channel_axis]:
            raise ValueError(f"Channel index {channel} is out of range")
        grayscale = np.take(grayscale, channel, axis=channel_axis)
        active_axes.pop(channel_axis)
    elif channel != 0:
        raise ValueError(f"Channel index {channel} is out of range")

    if "S" in active_axes:
        rgb_axis = active_axes.index("S")
        grayscale = np.rint(np.asarray(grayscale, dtype=np.float32).mean(axis=rgb_axis))
        active_axes.pop(rgb_axis)

    if active_axes != ["Y", "X"] or grayscale.ndim != 2:
        raise ValueError("Unsupported ND2 frame layout")

    return np.array(grayscale, copy=True)


def read_nd2_frame_2d(handle: Any, p: int, t: int, c: int, z: int) -> np.ndarray:
    sizes = {str(key): int(value) for key, value in handle.sizes.items()}
    seq_index = nd2_loop_index(handle, p, t, z)
    frame = handle.read_frame(seq_index)
    return nd2_frame_to_grayscale(frame, sizes, c)


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


def scan_nd2(path: str) -> dict[str, Any]:
    import nd2

    with nd2.ND2File(path) as handle:
        sizes = {str(key): int(value) for key, value in handle.sizes.items()}

    return {
        "positions": nd2_dimension_values(sizes, "P"),
        "channels": nd2_dimension_values(sizes, "C"),
        "times": nd2_dimension_values(sizes, "T"),
        "zSlices": nd2_dimension_values(sizes, "Z"),
    }


def scan_source(source: dict[str, str]) -> dict[str, Any]:
    normalized = normalize_source(source)
    if normalized["kind"] == "tif":
        return scan_workspace(normalized["path"])
    return scan_nd2(normalized["path"])


def app_icon() -> QIcon:
    if ICON_PATH.exists():
        return QIcon(str(ICON_PATH))
    return QIcon()


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


def validate_nd2_index(label: str, value: int, size: int) -> int:
    if value < 0 or value >= max(1, size):
        raise ValueError(f"{label} index {value} is out of range")
    return value


def load_nd2_frame(path: str, request: dict[str, int]) -> tuple[int, int, np.ndarray]:
    import nd2

    with nd2.ND2File(path) as handle:
        sizes = {str(key): int(value) for key, value in handle.sizes.items()}
        grayscale = read_nd2_frame_2d(
            handle,
            validate_nd2_index("Position", int(request["pos"]), nd2_dimension_size(sizes, "P")),
            validate_nd2_index("Time", int(request["time"]), nd2_dimension_size(sizes, "T")),
            validate_nd2_index("Channel", int(request["channel"]), nd2_dimension_size(sizes, "C")),
            validate_nd2_index("Z", int(request["z"]), nd2_dimension_size(sizes, "Z")),
        )
    grayscale = np.clip(grayscale, 0, np.iinfo(np.uint16).max).astype(np.uint16, copy=False)
    height, width = grayscale.shape
    return width, height, grayscale


def load_frame_for_source(source: dict[str, str], request: dict[str, int]) -> tuple[int, int, np.ndarray]:
    normalized = normalize_source(source)
    if normalized["kind"] == "tif":
        return load_frame(normalized["path"], request)
    return load_nd2_frame(normalized["path"], request)


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


def bbox_output_path(workspace_path: str, pos: int) -> Path:
    return Path(workspace_path) / "bbox" / f"Pos{pos}.csv"


def save_bbox_for_source(workspace_path: str, source: dict[str, str], pos: int, csv: str) -> dict[str, Any]:
    normalize_source(source)
    path = bbox_output_path(workspace_path, pos)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = csv if csv.endswith("\n") else f"{csv}\n"
    try:
        path.write_text(payload, encoding="utf-8")
        return {"ok": True}
    except OSError as error:
        return {"ok": False, "error": str(error)}


class LocalBackend:
    def scan_source(self, source: dict[str, str]) -> dict[str, Any]:
        return scan_source(source)

    def load_frame(
        self,
        source: dict[str, str],
        request: dict[str, int],
        contrast: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        width, height, frame = load_frame_for_source(source, request)
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

    def save_bbox(self, workspace_path: str, source: dict[str, str], pos: int, csv: str) -> dict[str, Any]:
        return save_bbox_for_source(workspace_path, source, pos, csv)


def ok_response(message_id: str, message_type: str, payload: Any) -> str:
    return json.dumps({"id": message_id, "type": message_type, "payload": payload})


def error_response(message_id: str, message: str) -> str:
    return ok_response(message_id, "error", {"message": message})


class WebSocketBackendServer:
    def __init__(self, backend: LocalBackend, host: str = BACKEND_HOST, port: int = 0) -> None:
        self._backend = backend
        self._host = host
        self._port = port
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop_event: asyncio.Event | None = None
        self._ready = threading.Event()
        self._started = threading.Event()
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="view-py-ws")
        self._bound_port: int | None = None
        self._startup_error: Exception | None = None

    @property
    def url(self) -> str:
        if self._bound_port is None:
            raise RuntimeError("WebSocket backend server has not started")
        return f"ws://{self._host}:{self._bound_port}"

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="view-py-backend", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=10.0)
        if self._startup_error is not None:
            raise RuntimeError("Failed to start websocket backend") from self._startup_error
        if not self._started.is_set():
            raise RuntimeError("Timed out while starting websocket backend")

    def stop(self) -> None:
        loop = self._loop
        stop_event = self._stop_event
        if loop is not None and stop_event is not None:
            loop.call_soon_threadsafe(stop_event.set)
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            self._thread = None
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        self._stop_event = asyncio.Event()
        try:
            loop.run_until_complete(self._serve())
        except Exception as error:  # noqa: BLE001
            self._startup_error = error
            self._ready.set()
        finally:
            pending = [task for task in asyncio.all_tasks(loop) if not task.done()]
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.close()
            self._loop = None
            self._stop_event = None

    async def _serve(self) -> None:
        assert self._stop_event is not None
        async with serve(self._handle_connection, self._host, self._port) as server:
            socket = server.sockets[0] if server.sockets else None
            if socket is None:
                raise RuntimeError("WebSocket backend failed to bind a socket")
            self._bound_port = int(socket.getsockname()[1])
            self._started.set()
            self._ready.set()
            await self._stop_event.wait()

    async def _handle_connection(self, websocket: Any) -> None:
        async for message in websocket:
            if not isinstance(message, str):
                continue
            response = await self._handle_request(message)
            if response is None:
                continue
            await websocket.send(response)

    async def _handle_request(self, text: str) -> str | None:
        try:
            envelope = json.loads(text)
        except json.JSONDecodeError:
            return None

        if not isinstance(envelope, dict):
            return None

        message_id = str(envelope.get("id", ""))
        message_type = envelope.get("type")
        payload = envelope.get("payload")
        if not message_id or not isinstance(message_type, str):
            return None

        loop = asyncio.get_running_loop()
        try:
            if message_type == "scan_source":
                if not isinstance(payload, dict):
                    raise ValueError("Invalid scan_source payload")
                source = normalize_source(payload.get("source"))
                result = await loop.run_in_executor(self._executor, self._backend.scan_source, source)
                return ok_response(message_id, "scan_source_result", result)

            if message_type == "load_frame":
                if not isinstance(payload, dict):
                    raise ValueError("Invalid load_frame payload")
                source = normalize_source(payload.get("source"))
                request = payload.get("request")
                contrast = payload.get("contrast")
                if not isinstance(request, dict):
                    raise ValueError("Invalid load_frame payload")
                normalized_request = {
                    "pos": int(request["pos"]),
                    "channel": int(request["channel"]),
                    "time": int(request["time"]),
                    "z": int(request["z"]),
                }
                normalized_contrast = None
                if isinstance(contrast, dict):
                    normalized_contrast = {"min": int(contrast["min"]), "max": int(contrast["max"])}
                result = await loop.run_in_executor(
                    self._executor,
                    self._backend.load_frame,
                    source,
                    normalized_request,
                    normalized_contrast,
                )
                return ok_response(message_id, "load_frame_result", result)

            if message_type == "save_bbox":
                if not isinstance(payload, dict):
                    raise ValueError("Invalid save_bbox payload")
                workspace_path = payload.get("workspacePath")
                source = normalize_source(payload.get("source"))
                pos = payload.get("pos")
                csv = payload.get("csv")
                if not isinstance(workspace_path, str) or not workspace_path or not isinstance(pos, int) or not isinstance(csv, str):
                    raise ValueError("Invalid save_bbox payload")
                result = await loop.run_in_executor(
                    self._executor,
                    self._backend.save_bbox,
                    workspace_path,
                    source,
                    pos,
                    csv,
                )
                return ok_response(message_id, "save_bbox_result", result)

            return error_response(message_id, "Unsupported request type")
        except Exception as error:  # noqa: BLE001
            return error_response(message_id, str(error))


class CanvasBridge(QObject):
    def __init__(self, window: "ViewerMainWindow") -> None:
        super().__init__()
        self._window = window

    @Slot(str)
    def postMessage(self, message: str) -> None:
        self._window.handle_canvas_message(message)


class ViewerMainWindow(QMainWindow):
    def __init__(self, backend_url: str) -> None:
        super().__init__()
        self._backend = LocalBackend()
        self._backend_url = backend_url
        self._workspace_path: str | None = None
        self._source: dict[str, str] | None = None
        self._scan: dict[str, list[int]] | None = None
        self._selection: dict[str, int] | None = None
        self._grid = create_default_grid()
        self._frame_payload: dict[str, Any] | None = None
        self._contrast_mode = "manual"
        self._contrast_domain = {"min": 0, "max": 65535}
        self._contrast_min = 0
        self._contrast_max = 65535
        self._auto_contrast_request_token = 0
        self._selection_mode = False
        self._time_values: list[int] = []
        self._excluded_cell_ids_by_position: ExcludedCellIdsByPosition = {}
        self._error_message: str | None = None
        self._save_message: tuple[str, str] | None = None
        self._loading = False
        self._canvas_ready = False

        self.setWindowTitle("View")
        self.setWindowIcon(app_icon())
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

        self.open_workspace_button = QPushButton("Workspace")
        self.open_workspace_button.clicked.connect(self.open_workspace)
        self.open_tif_button = QPushButton("Open TIF")
        self.open_tif_button.clicked.connect(self.open_tif)
        self.open_nd2_button = QPushButton("Open ND2")
        self.open_nd2_button.clicked.connect(self.open_nd2)
        self.clear_button = QPushButton("Clear")
        self.clear_button.clicked.connect(self.clear_source)
        self.root_label = QLabel("No source selected")
        self.root_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.root_label.setAlignment(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft)
        self.root_label.setWordWrap(True)

        header_layout.addWidget(self.open_workspace_button)
        header_layout.addWidget(self.open_tif_button)
        header_layout.addWidget(self.open_nd2_button)
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
        panel = QGroupBox()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(12)

        layout.addWidget(self._create_section_header("Image"))
        image_form = QFormLayout()
        self.position_combo = QComboBox()
        self.position_combo.currentIndexChanged.connect(self._on_position_changed)
        self.channel_combo = QComboBox()
        self.channel_combo.currentIndexChanged.connect(self._on_channel_changed)
        self.time_slider = self._create_slider(0, 0)
        self.time_slider.valueChanged.connect(self._on_time_slider_changed)
        self.time_slider.sliderReleased.connect(self._commit_time_slider)
        self.time_value_label = QLabel("0")
        self.time_value_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.time_value_label.setMinimumWidth(40)
        self.z_combo = QComboBox()
        self.z_combo.currentIndexChanged.connect(self._on_z_changed)
        image_form.addRow("Position", self.position_combo)
        image_form.addRow("Channel", self.channel_combo)
        image_form.addRow("Time", self._create_slider_row(self.time_slider, self.time_value_label))
        image_form.addRow("Z Slice", self.z_combo)
        layout.addLayout(image_form)

        layout.addSpacing(4)
        self.auto_contrast_button = QPushButton("Auto")
        self.auto_contrast_button.clicked.connect(self._on_auto_contrast)
        layout.addWidget(self._create_section_header("Contrast", [self.auto_contrast_button]))
        contrast_layout = QVBoxLayout()
        contrast_layout.setContentsMargins(0, 0, 0, 0)
        contrast_layout.setSpacing(8)

        contrast_form = QFormLayout()
        self.contrast_min_label = self._create_value_label("0")
        self.contrast_min_slider = self._create_slider(0, 65534)
        self.contrast_min_slider.valueChanged.connect(self._on_contrast_slider_changed)
        self.contrast_min_slider.sliderReleased.connect(self._on_contrast_changed)
        self.contrast_max_label = self._create_value_label("65535")
        self.contrast_max_slider = self._create_slider(1, 65535)
        self.contrast_max_slider.valueChanged.connect(self._on_contrast_slider_changed)
        self.contrast_max_slider.sliderReleased.connect(self._on_contrast_changed)
        contrast_form.addRow("Minimum", self._create_slider_row(self.contrast_min_slider, self.contrast_min_label))
        contrast_form.addRow("Maximum", self._create_slider_row(self.contrast_max_slider, self.contrast_max_label))
        contrast_layout.addLayout(contrast_form)
        layout.addLayout(contrast_layout)
        layout.addStretch(1)

        panel.setMinimumWidth(280)
        panel.setMaximumWidth(280)
        return panel

    def _build_canvas_panel(self) -> QWidget:
        self.view = QWebEngineView()
        settings = self.view.settings()
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        settings.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        self._web_channel = QWebChannel(self.view.page())
        self._canvas_bridge = CanvasBridge(self)
        self._web_channel.registerObject("viewBridge", self._canvas_bridge)
        self.view.page().setWebChannel(self._web_channel)
        self._canvas_ready = False
        self.view.setMinimumSize(320, 240)
        return self.view

    def _build_right_panel(self) -> QWidget:
        panel = QGroupBox()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(12)

        self.disable_edge_button = QPushButton("Disable Edge")
        self.disable_edge_button.clicked.connect(self.disable_edge_bbox)
        self.grid_reset_button = QPushButton("Reset")
        self.grid_reset_button.clicked.connect(self._on_grid_reset)
        self.grid_enabled_button = QPushButton("Off")
        self.grid_enabled_button.clicked.connect(lambda *_args: self._on_grid_enabled_toggled(not bool(self._grid["enabled"])))
        layout.addWidget(
            self._create_section_header(
                "Grid",
                [self.grid_reset_button, self.grid_enabled_button],
            )
        )

        grid_form = QFormLayout()
        self.grid_shape_combo = QComboBox()
        self.grid_shape_combo.addItem("Square", "square")
        self.grid_shape_combo.addItem("Hex", "hex")
        self.grid_shape_combo.currentIndexChanged.connect(self._on_grid_shape_changed)
        self.grid_rotation_slider = self._create_slider(-1800, 1800)
        self.grid_rotation_slider.valueChanged.connect(self._on_grid_rotation_slider_changed)
        self.grid_rotation_label = self._create_value_label("0.0°")
        self.grid_spacing_a_input = self._create_number_input(1.0, 10000.0, 2)
        self.grid_spacing_a_input.editingFinished.connect(self._on_grid_spacing_changed)
        self.grid_spacing_b_input = self._create_number_input(1.0, 10000.0, 2)
        self.grid_spacing_b_input.editingFinished.connect(self._on_grid_spacing_changed)
        self.grid_cell_width_input = self._create_number_input(1.0, 10000.0, 2)
        self.grid_cell_width_input.editingFinished.connect(self._on_grid_cell_size_changed)
        self.grid_cell_height_input = self._create_number_input(1.0, 10000.0, 2)
        self.grid_cell_height_input.editingFinished.connect(self._on_grid_cell_size_changed)
        self.grid_tx_input = self._create_number_input(-100000.0, 100000.0, 2)
        self.grid_tx_input.editingFinished.connect(self._on_grid_offset_changed)
        self.grid_ty_input = self._create_number_input(-100000.0, 100000.0, 2)
        self.grid_ty_input.editingFinished.connect(self._on_grid_offset_changed)
        self.grid_opacity_slider = self._create_slider(0, 100)
        self.grid_opacity_slider.valueChanged.connect(self._on_grid_opacity_slider_changed)
        self.grid_opacity_label = self._create_value_label("0.50")
        grid_form.addRow("Shape", self.grid_shape_combo)
        grid_form.addRow("Rotation", self._create_slider_row(self.grid_rotation_slider, self.grid_rotation_label))
        grid_form.addRow(
            "Spacing",
            self._create_pair_input_row("A", self.grid_spacing_a_input, "B", self.grid_spacing_b_input),
        )
        grid_form.addRow(
            "Cell",
            self._create_pair_input_row("W", self.grid_cell_width_input, "H", self.grid_cell_height_input),
        )
        grid_form.addRow(
            "Offset",
            self._create_pair_input_row("X", self.grid_tx_input, "Y", self.grid_ty_input),
        )
        grid_form.addRow("Opacity", self._create_slider_row(self.grid_opacity_slider, self.grid_opacity_label))
        layout.addLayout(grid_form)

        layout.addSpacing(4)
        self.selection_mode_button = QPushButton("Off")
        self.selection_mode_button.clicked.connect(
            lambda *_args: self._on_selection_mode_toggled(not self._selection_mode)
        )
        self.save_button = QPushButton("Save")
        self.save_button.clicked.connect(self.save_current_bbox)
        layout.addWidget(
            self._create_section_header(
                "Select",
                [self.disable_edge_button, self.save_button, self.selection_mode_button],
            )
        )

        self.included_count_label = QLabel("0")
        self.included_count_label.setStyleSheet("font-weight: 600;")
        self.excluded_count_label = QLabel("0")
        self.excluded_count_label.setStyleSheet("font-weight: 600;")
        layout.addWidget(
            self._create_pair_value_row("Included", self.included_count_label, "Excluded", self.excluded_count_label)
        )
        layout.addStretch(1)

        panel.setMinimumWidth(320)
        panel.setMaximumWidth(320)
        return panel

    def _create_slider(self, minimum: int, maximum: int) -> QSlider:
        slider = QSlider(Qt.Orientation.Horizontal)
        slider.setRange(minimum, maximum)
        slider.setSingleStep(1)
        slider.setPageStep(max(1, (maximum - minimum) // 20))
        return slider

    def _create_number_input(self, minimum: float, maximum: float, decimals: int) -> QLineEdit:
        input_widget = QLineEdit()
        validator = QDoubleValidator(minimum, maximum, decimals, input_widget)
        validator.setNotation(QDoubleValidator.Notation.StandardNotation)
        input_widget.setValidator(validator)
        input_widget.setAlignment(Qt.AlignmentFlag.AlignRight)
        input_widget.setFixedWidth(72)
        return input_widget

    def _create_value_label(self, text: str) -> QLabel:
        label = QLabel(text)
        label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        label.setMinimumWidth(56)
        return label

    def _create_slider_row(self, slider: QWidget, tail: QWidget) -> QWidget:
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        layout.addWidget(slider, 1)
        layout.addWidget(tail)
        return row

    def _create_pair_input_row(self, left_label: str, left_widget: QWidget, right_label: str, right_widget: QWidget) -> QWidget:
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        layout.addWidget(QLabel(left_label))
        layout.addWidget(left_widget)
        layout.addSpacing(4)
        layout.addWidget(QLabel(right_label))
        layout.addWidget(right_widget)
        layout.addStretch(1)
        return row

    def _create_pair_value_row(self, left_label: str, left_widget: QWidget, right_label: str, right_widget: QWidget) -> QWidget:
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)
        layout.addWidget(QLabel(left_label))
        layout.addWidget(left_widget)
        layout.addSpacing(8)
        layout.addWidget(QLabel(right_label))
        layout.addWidget(right_widget)
        layout.addStretch(1)
        return row

    def _create_section_label(self, text: str) -> QLabel:
        label = QLabel(text)
        label.setStyleSheet("font-weight: 600;")
        return label

    def _create_section_header(self, text: str, actions: list[QWidget] | None = None) -> QWidget:
        header = QWidget()
        layout = QHBoxLayout(header)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        layout.addWidget(self._create_section_label(text))
        layout.addStretch(1)
        for action in actions or []:
            layout.addWidget(action)
        return header

    def _with_wait_cursor(self, callback: Callable[..., Any], *args: Any) -> Any:
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            return callback(*args)
        finally:
            QApplication.restoreOverrideCursor()

    def _active_excluded_cell_ids(self) -> set[str]:
        if not self._selection:
            return set()
        return set(self._excluded_cell_ids_by_position.get(self._selection["pos"], []))

    def _frame_size(self) -> tuple[int, int] | None:
        if not self._frame_payload:
            return None
        return int(self._frame_payload["width"]), int(self._frame_payload["height"])

    def _empty_text(self) -> str:
        if not self._workspace_path:
            return "Select a workspace folder to save bbox CSVs"
        if not self._source:
            return "Select a TIF folder or ND2 file to load frames"
        if self._scan is not None and not self._selection:
            return "No frames found in ND2 file" if self._source["kind"] == "nd2" else "No frames found in TIF folder"
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
            "backendUrl": self._backend_url,
            "source": dict(self._source) if self._source else None,
            "request": dict(self._selection) if self._selection else None,
            "contrast": {
                "mode": self._contrast_mode,
                "value": {"min": int(self._contrast_min), "max": int(self._contrast_max)}
                if self._contrast_mode == "manual"
                else None,
            },
            "autoContrastRequestToken": int(self._auto_contrast_request_token),
            "grid": self._grid,
            "excludedCellIds": sorted(self._active_excluded_cell_ids()),
            "selectionMode": self._selection_mode,
            "emptyText": self._empty_text(),
            "messages": self._canvas_messages(),
        }
        self.view.page().runJavaScript(f"window.__viewPyApplyState?.({json.dumps(payload)});")

    def _sync_root_label(self) -> None:
        workspace_text = self._workspace_path if self._workspace_path else "not selected"
        source_text = self._source["path"] if self._source else "not selected"
        self.root_label.setText(f"Workspace: {workspace_text}\nSource: {source_text}")
        self.clear_button.setEnabled(self._source is not None)

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
        self._set_combo_items(self.z_combo, list(scan.get("zSlices", [])), self._selection["z"] if self._selection else None)
        self._time_values = [int(value) for value in scan.get("times", [])]
        slider_blocker = QSignalBlocker(self.time_slider)
        if self._time_values:
            current_time = self._selection["time"] if self._selection else self._time_values[0]
            try:
                current_index = self._time_values.index(current_time)
            except ValueError:
                current_index = 0
            self.time_slider.setRange(0, max(0, len(self._time_values) - 1))
            self.time_slider.setValue(current_index)
            self.time_value_label.setText(str(self._time_values[current_index]))
        else:
            self.time_slider.setRange(0, 0)
            self.time_slider.setValue(0)
            self.time_value_label.setText("0")
        del slider_blocker

    def _format_number(self, value: float, decimals: int) -> str:
        if decimals == 0:
            return str(int(round(value)))
        return f"{value:.{decimals}f}".rstrip("0").rstrip(".")

    def _set_number_input_value(self, widget: QLineEdit, value: float, decimals: int) -> None:
        blocker = QSignalBlocker(widget)
        widget.setText(self._format_number(value, decimals))
        del blocker

    def _read_number_input_value(self, widget: QLineEdit, fallback: float) -> float:
        text = widget.text().strip()
        if not text:
            return fallback
        try:
            return float(text)
        except ValueError:
            return fallback

    def _normalize_contrast_values(
        self,
        minimum: float,
        maximum: float,
        preferred: str,
    ) -> tuple[int, int]:
        domain_min = int(self._contrast_domain["min"])
        domain_max = int(self._contrast_domain["max"])
        next_min = int(round(minimum))
        next_max = int(round(maximum))
        next_min = int(clamp(next_min, domain_min, max(domain_min, domain_max - 1)))
        next_max = int(clamp(next_max, min(domain_min + 1, domain_max), domain_max))
        if next_min >= next_max:
            if preferred == "min":
                next_min = max(domain_min, next_max - 1)
            else:
                next_max = min(domain_max, next_min + 1)
        return next_min, next_max

    def _set_contrast_controls(self, minimum: int, maximum: int) -> None:
        normalized_min, normalized_max = self._normalize_contrast_values(minimum, maximum, "max")
        domain_min = int(self._contrast_domain["min"])
        domain_max = int(self._contrast_domain["max"])
        min_upper = max(domain_min, domain_max - 1)
        max_lower = min(domain_max, domain_min + 1)
        blockers = [
            QSignalBlocker(self.contrast_min_slider),
            QSignalBlocker(self.contrast_max_slider),
        ]
        self.contrast_min_slider.setRange(domain_min, max(domain_min, normalized_max - 1))
        self.contrast_max_slider.setRange(min(domain_max, normalized_min + 1), domain_max)
        self.contrast_min_slider.setValue(normalized_min)
        self.contrast_max_slider.setValue(normalized_max)
        self.contrast_min_label.setText(str(normalized_min))
        self.contrast_max_label.setText(str(normalized_max))
        del blockers

    def _sync_contrast_controls(self) -> None:
        self._set_contrast_controls(int(self._contrast_min), int(self._contrast_max))

    def _sync_grid_controls(self) -> None:
        blockers = [
            QSignalBlocker(self.grid_shape_combo),
            QSignalBlocker(self.grid_rotation_slider),
            QSignalBlocker(self.grid_opacity_slider),
        ]
        min_spacing = minimum_grid_spacing(float(self._grid["cellWidth"]), float(self._grid["cellHeight"]))
        self.grid_enabled_button.setText("On" if self._grid["enabled"] else "Off")
        self.grid_shape_combo.setCurrentIndex(0 if self._grid["shape"] == "square" else 1)
        rotation_degrees = math.degrees(float(self._grid["rotation"]))
        self.grid_rotation_slider.setValue(int(round(rotation_degrees * 10)))
        self.grid_rotation_label.setText(f"{rotation_degrees:.1f}°")
        self._set_number_input_value(self.grid_spacing_a_input, float(self._grid["spacingA"]), 2)
        self._set_number_input_value(self.grid_spacing_b_input, float(self._grid["spacingB"]), 2)
        self._set_number_input_value(self.grid_cell_width_input, float(self._grid["cellWidth"]), 2)
        self._set_number_input_value(self.grid_cell_height_input, float(self._grid["cellHeight"]), 2)
        self._set_number_input_value(self.grid_tx_input, float(self._grid["tx"]), 2)
        self._set_number_input_value(self.grid_ty_input, float(self._grid["ty"]), 2)
        for input_widget, minimum in (
            (self.grid_spacing_a_input, min_spacing),
            (self.grid_spacing_b_input, min_spacing),
            (self.grid_cell_width_input, 1.0),
            (self.grid_cell_height_input, 1.0),
            (self.grid_tx_input, -100000.0),
            (self.grid_ty_input, -100000.0),
        ):
            validator = input_widget.validator()
            if isinstance(validator, QDoubleValidator):
                validator.setBottom(minimum)
        self.grid_opacity_slider.setValue(int(round(float(self._grid["opacity"]) * 100)))
        self.grid_opacity_label.setText(f"{float(self._grid['opacity']):.2f}")
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
        has_workspace = self._workspace_path is not None
        has_selection = self._selection is not None
        has_frame = self._frame_payload is not None
        grid_controls_enabled = has_selection

        self.open_tif_button.setEnabled(has_workspace)
        self.open_nd2_button.setEnabled(has_workspace)
        self.position_combo.setEnabled(has_selection)
        self.channel_combo.setEnabled(has_selection)
        self.time_slider.setEnabled(has_selection and len(self._time_values) > 0)
        self.z_combo.setEnabled(has_selection)
        self.auto_contrast_button.setEnabled(has_frame)
        self.contrast_min_slider.setEnabled(has_frame)
        self.contrast_max_slider.setEnabled(has_frame)
        self.grid_reset_button.setEnabled(grid_controls_enabled)
        self.grid_enabled_button.setEnabled(grid_controls_enabled)
        self.grid_shape_combo.setEnabled(grid_controls_enabled)
        self.grid_rotation_slider.setEnabled(grid_controls_enabled)
        self.grid_spacing_a_input.setEnabled(grid_controls_enabled)
        self.grid_spacing_b_input.setEnabled(grid_controls_enabled)
        self.grid_cell_width_input.setEnabled(grid_controls_enabled)
        self.grid_cell_height_input.setEnabled(grid_controls_enabled)
        self.grid_tx_input.setEnabled(grid_controls_enabled)
        self.grid_ty_input.setEnabled(grid_controls_enabled)
        self.grid_opacity_slider.setEnabled(grid_controls_enabled)
        selection_enabled = has_frame and bool(self._grid["enabled"])
        self.selection_mode_button.setEnabled(selection_enabled)
        self.disable_edge_button.setEnabled(has_frame and has_selection)
        self.save_button.setEnabled(has_workspace and has_frame and has_selection)
        if not selection_enabled and self._selection_mode:
            self._selection_mode = False
        self.selection_mode_button.setText("On" if self._selection_mode else "Off")

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

    def _set_source_state(self, source: dict[str, str] | None) -> None:
        self._source = dict(source) if source else None
        self._scan = None
        self._selection = None
        self._frame_payload = None
        self._contrast_mode = "manual"
        self._contrast_domain = {"min": 0, "max": 65535}
        self._contrast_min = 0
        self._contrast_max = 65535
        self._auto_contrast_request_token = 0
        self._selection_mode = False
        self._time_values = []
        self._excluded_cell_ids_by_position = clear_excluded_cell_ids()
        self._set_error(None)
        self._clear_save_message()

    def open_workspace(self, *_args: Any) -> None:
        selected = QFileDialog.getExistingDirectory(self, "Select Workspace")
        if not selected:
            return

        self._workspace_path = selected
        self._clear_save_message()
        self._sync_ui()
        self._publish_canvas_state()

    def open_tif(self, *_args: Any) -> None:
        if not self._workspace_path:
            return
        selected = QFileDialog.getExistingDirectory(self, "Open TIF Folder")
        if not selected:
            return

        source = {"kind": "tif", "path": selected}
        self._set_source_state(source)
        self._loading = True
        self._sync_ui()
        self._publish_canvas_state()
        try:
            scan = self._with_wait_cursor(self._backend.scan_source, source)
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

    def open_nd2(self, *_args: Any) -> None:
        if not self._workspace_path:
            return
        selected, _ = QFileDialog.getOpenFileName(self, "Open ND2", "", "ND2 Files (*.nd2)")
        if not selected:
            return

        source = {"kind": "nd2", "path": selected}
        self._set_source_state(source)
        self._loading = True
        self._sync_ui()
        self._publish_canvas_state()
        try:
            scan = self._with_wait_cursor(self._backend.scan_source, source)
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

    def clear_source(self, *_args: Any) -> None:
        self._set_source_state(None)
        self._loading = False
        self._sync_ui()
        self._publish_canvas_state()

    def load_current_frame(self) -> None:
        if not self._source or not self._selection:
            self._frame_payload = None
            self._sync_ui()
            self._publish_canvas_state()
            return

        self._frame_payload = None
        self._clear_save_message()
        self._set_error(None)
        self._sync_ui()
        self._publish_canvas_state()

    def save_current_bbox(self, *_args: Any) -> None:
        frame_size = self._frame_size()
        if not self._workspace_path or not self._source or not self._selection or not frame_size:
            return

        csv = build_bbox_csv(frame_size[0], frame_size[1], self._grid, self._active_excluded_cell_ids())
        try:
            response = self._with_wait_cursor(
                self._backend.save_bbox,
                self._workspace_path,
                self._source,
                int(self._selection["pos"]),
                csv,
            )
            if response.get("ok"):
                self._save_message = ("success", f"Saved bbox CSV for Pos{self._selection['pos']}")
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

    def _on_time_slider_changed(self, value: int) -> None:
        if not self._time_values:
            self.time_value_label.setText("0")
            return
        index = int(clamp(value, 0, len(self._time_values) - 1))
        self.time_value_label.setText(str(self._time_values[index]))
        if not self.time_slider.isSliderDown():
            self._commit_time_slider()

    def _commit_time_slider(self) -> None:
        if not self._time_values:
            return
        index = int(clamp(self.time_slider.value(), 0, len(self._time_values) - 1))
        self.time_value_label.setText(str(self._time_values[index]))
        self._set_selection_key("time", int(self._time_values[index]))

    def _on_z_changed(self, *_args: Any) -> None:
        value = self.z_combo.currentData()
        if value is not None:
            self._set_selection_key("z", int(value))

    def _on_auto_contrast(self, *_args: Any) -> None:
        if not self._selection:
            return
        self._contrast_mode = "auto"
        self._auto_contrast_request_token += 1
        self.load_current_frame()

    def _on_contrast_slider_changed(self, *_args: Any) -> None:
        preferred = "min" if self.sender() is self.contrast_min_slider else "max"
        minimum, maximum = self._normalize_contrast_values(
            self.contrast_min_slider.value(),
            self.contrast_max_slider.value(),
            preferred,
        )
        self._set_contrast_controls(minimum, maximum)
        if not (
            self.contrast_min_slider.isSliderDown()
            or self.contrast_max_slider.isSliderDown()
        ):
            self._on_contrast_changed()

    def _on_contrast_changed(self, *_args: Any) -> None:
        if not self._frame_payload:
            return
        preferred = "min" if self.sender() is self.contrast_min_slider else "max"
        minimum, maximum = self._normalize_contrast_values(
            self.contrast_min_slider.value(),
            self.contrast_max_slider.value(),
            preferred,
        )
        self._set_contrast_controls(minimum, maximum)
        self._contrast_mode = "manual"
        self._contrast_min = minimum
        self._contrast_max = maximum
        self.load_current_frame()

    def _on_grid_reset(self, *_args: Any) -> None:
        self._excluded_cell_ids_by_position = clear_excluded_cell_ids()
        self._update_grid({**create_default_grid(), "enabled": self._grid["enabled"]})

    def _on_grid_enabled_toggled(self, checked: bool) -> None:
        self._update_grid({"enabled": checked})

    def _on_grid_shape_changed(self, *_args: Any) -> None:
        value = self.grid_shape_combo.currentData()
        if value is not None:
            self._update_grid({"shape": str(value)})

    def _on_grid_rotation_slider_changed(self, value: int) -> None:
        degrees = value / 10.0
        self.grid_rotation_label.setText(f"{degrees:.1f}°")
        self._update_grid({"rotation": math.radians(degrees)})

    def _on_grid_spacing_changed(self, *_args: Any) -> None:
        min_spacing = minimum_grid_spacing(float(self._grid["cellWidth"]), float(self._grid["cellHeight"]))
        spacing_a = max(min_spacing, self._read_number_input_value(self.grid_spacing_a_input, float(self._grid["spacingA"])))
        spacing_b = max(min_spacing, self._read_number_input_value(self.grid_spacing_b_input, float(self._grid["spacingB"])))
        self._update_grid({"spacingA": spacing_a, "spacingB": spacing_b})

    def _on_grid_cell_size_changed(self, *_args: Any) -> None:
        cell_width = max(1.0, self._read_number_input_value(self.grid_cell_width_input, float(self._grid["cellWidth"])))
        cell_height = max(1.0, self._read_number_input_value(self.grid_cell_height_input, float(self._grid["cellHeight"])))
        self._update_grid({"cellWidth": cell_width, "cellHeight": cell_height})

    def _on_grid_offset_changed(self, *_args: Any) -> None:
        tx = self._read_number_input_value(self.grid_tx_input, float(self._grid["tx"]))
        ty = self._read_number_input_value(self.grid_ty_input, float(self._grid["ty"]))
        self._update_grid({"tx": tx, "ty": ty})

    def _on_grid_opacity_slider_changed(self, value: int) -> None:
        opacity = value / 100.0
        self.grid_opacity_label.setText(f"{opacity:.2f}")
        self._update_grid({"opacity": opacity})

    def _on_selection_mode_toggled(self, checked: bool) -> None:
        enabled = bool(checked and self._frame_payload and self._grid["enabled"])
        if enabled == self._selection_mode:
            return
        self._selection_mode = enabled
        self._publish_canvas_state()

    def handle_canvas_ready(self) -> None:
        self._canvas_ready = True
        self._publish_canvas_state()

    def handle_canvas_message(self, message: str) -> None:
        try:
            envelope = json.loads(message)
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
        if message_type == "excludedCellsToggled":
            self.handle_canvas_excluded_cells_toggled(payload)
            return
        if message_type == "frameLoaded":
            self.handle_canvas_frame_loaded(payload)
            return
        if message_type == "frameLoadFailed":
            self.handle_canvas_frame_load_failed(payload)

    def handle_canvas_grid_changed(self, payload: Any) -> None:
        self._grid = normalize_grid_state(payload if isinstance(payload, dict) else None)
        if not self._grid["enabled"]:
            self._selection_mode = False
        self._clear_save_message()
        self._sync_ui()

    def handle_canvas_excluded_cells_toggled(self, payload: Any) -> None:
        if not self._selection:
            return
        if not isinstance(payload, list):
            return

        position = int(self._selection["pos"])
        toggled_cell_ids = [value for value in payload if isinstance(value, str)]
        if not toggled_cell_ids:
            return
        next_excluded = toggle_excluded_cell_ids(
            self._excluded_cell_ids_by_position.get(position, []),
            toggled_cell_ids,
        )
        self._excluded_cell_ids_by_position = set_excluded_cell_ids_for_position(
            self._excluded_cell_ids_by_position,
            position,
            next_excluded,
        )
        self._clear_save_message()
        self._refresh_counts()

    def handle_canvas_frame_loaded(self, payload: Any) -> None:
        if not isinstance(payload, dict):
            return
        try:
            width = int(payload["width"])
            height = int(payload["height"])
        except (KeyError, TypeError, ValueError):
            return

        self._frame_payload = {"width": width, "height": height}
        contrast_domain = payload.get("contrastDomain")
        if isinstance(contrast_domain, dict):
            self._contrast_domain = {
                "min": int(contrast_domain.get("min", 0)),
                "max": int(contrast_domain.get("max", max(1, self._contrast_domain["max"]))),
            }
        applied = payload.get("appliedContrast") or payload.get("suggestedContrast") or self._contrast_domain
        if isinstance(applied, dict):
            self._contrast_min = int(
                clamp(
                    int(applied.get("min", self._contrast_min)),
                    self._contrast_domain["min"],
                    max(self._contrast_domain["min"], self._contrast_domain["max"] - 1),
                )
            )
            self._contrast_max = int(
                clamp(
                    int(applied.get("max", self._contrast_max)),
                    min(self._contrast_domain["min"] + 1, self._contrast_domain["max"]),
                    self._contrast_domain["max"],
                )
            )
        if self._contrast_mode == "auto":
            self._contrast_mode = "manual"
        self._set_error(None)
        self._sync_ui()
        self._publish_canvas_state()

    def disable_edge_bbox(self, *_args: Any) -> None:
        frame_size = self._frame_size()
        if not self._selection or not frame_size:
            return

        edge_cell_ids = collect_edge_cell_ids(frame_size[0], frame_size[1], self._grid)
        if not edge_cell_ids:
            return

        position = int(self._selection["pos"])
        next_excluded = merge_excluded_cell_ids(
            self._excluded_cell_ids_by_position.get(position, []),
            edge_cell_ids,
        )
        if next_excluded == self._excluded_cell_ids_by_position.get(position, []):
            return

        self._excluded_cell_ids_by_position = set_excluded_cell_ids_for_position(
            self._excluded_cell_ids_by_position,
            position,
            next_excluded,
        )
        self._clear_save_message()
        self._sync_ui()
        self._publish_canvas_state()

    def handle_canvas_frame_load_failed(self, payload: Any) -> None:
        if isinstance(payload, dict) and isinstance(payload.get("message"), str):
            self._set_error(payload["message"])
        else:
            self._set_error("Failed to load frame")
        self._frame_payload = None
        self._sync_ui()
        self._publish_canvas_state()


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
    app.setWindowIcon(app_icon())
    frontend_url, stop_frontend_server = resolve_frontend_url()
    backend_server = WebSocketBackendServer(LocalBackend())
    backend_server.start()
    try:
        window = ViewerMainWindow(backend_server.url)
        window.view.setUrl(frontend_url)
        window.show()
        return app.exec()
    finally:
        backend_server.stop()
        if stop_frontend_server is not None:
            stop_frontend_server()
