from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

MAX_GRID_RECTS = 8000
GRID_BOUNDS_EPSILON = 1e-6
GridState = dict[str, Any]


@dataclass(frozen=True)
class GridCellRect:
    id: str
    x: float
    y: float
    width: float
    height: float


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def create_default_grid() -> GridState:
    return {
        "enabled": False,
        "shape": "square",
        "tx": 0.0,
        "ty": 0.0,
        "rotation": 0.0,
        "spacingA": 325.0,
        "spacingB": 325.0,
        "cellWidth": 200.0,
        "cellHeight": 200.0,
        "opacity": 0.35,
    }


def minimum_grid_spacing(cell_width: float, cell_height: float) -> float:
    return max(1.0, min(cell_width, cell_height))


def normalize_grid_state(input_grid: GridState | None = None) -> GridState:
    base = create_default_grid()
    if input_grid is None:
        return base

    shape = str(input_grid.get("shape", base["shape"]))
    cell_width = max(1.0, float(input_grid.get("cellWidth", base["cellWidth"])))
    cell_height = max(1.0, float(input_grid.get("cellHeight", base["cellHeight"])))
    min_spacing = minimum_grid_spacing(cell_width, cell_height)
    return {
        "enabled": bool(input_grid.get("enabled", base["enabled"])),
        "shape": shape if shape in {"square", "hex"} else base["shape"],
        "tx": float(input_grid.get("tx", base["tx"])),
        "ty": float(input_grid.get("ty", base["ty"])),
        "rotation": float(input_grid.get("rotation", base["rotation"])),
        "spacingA": max(min_spacing, float(input_grid.get("spacingA", base["spacingA"]))),
        "spacingB": max(min_spacing, float(input_grid.get("spacingB", base["spacingB"]))),
        "cellWidth": cell_width,
        "cellHeight": cell_height,
        "opacity": clamp(float(input_grid.get("opacity", base["opacity"])), 0.0, 1.0),
    }


def grid_basis(
    shape: str,
    rotation: float,
    spacing_a: float,
    spacing_b: float,
) -> tuple[tuple[float, float], tuple[float, float]]:
    second_angle = rotation + (math.pi / 2 if shape == "square" else math.pi / 3)
    return (
        (math.cos(rotation) * spacing_a, math.sin(rotation) * spacing_a),
        (math.cos(second_angle) * spacing_b, math.sin(second_angle) * spacing_b),
    )


def estimate_grid_draw(
    width: int,
    height: int,
    spacing_a: float,
    spacing_b: float,
    _max_rects: int = MAX_GRID_RECTS,
) -> tuple[int, int]:
    min_spacing = max(1.0, min(spacing_a, spacing_b))
    estimated_columns = math.ceil(width / min_spacing) + 3
    estimated_rows = math.ceil(height / min_spacing) + 3
    value_range = max(estimated_columns, estimated_rows)
    stride = 1
    return value_range, stride


def resolve_visible_grid_index_bounds(
    frame_width: int,
    frame_height: int,
    grid: GridState,
) -> tuple[tuple[float, float], tuple[float, float], float, float, float, float, int, int, int, int]:
    (ax, ay), (bx, by) = grid_basis(
        str(grid["shape"]),
        float(grid["rotation"]),
        float(grid["spacingA"]),
        float(grid["spacingB"]),
    )
    origin_x = frame_width / 2 + float(grid["tx"])
    origin_y = frame_height / 2 + float(grid["ty"])
    half_width = float(grid["cellWidth"]) / 2
    half_height = float(grid["cellHeight"]) / 2
    determinant = ax * by - ay * bx

    if abs(determinant) <= GRID_BOUNDS_EPSILON:
        value_range, _stride = estimate_grid_draw(
            frame_width,
            frame_height,
            float(grid["spacingA"]),
            float(grid["spacingB"]),
        )
        return (
            (ax, ay),
            (bx, by),
            origin_x,
            origin_y,
            half_width,
            half_height,
            -value_range,
            value_range,
            -value_range,
            value_range,
        )

    corners = (
        (-half_width, -half_height),
        (frame_width + half_width, -half_height),
        (-half_width, frame_height + half_height),
        (frame_width + half_width, frame_height + half_height),
    )
    i_values: list[float] = []
    j_values: list[float] = []

    for corner_x, corner_y in corners:
        dx = corner_x - origin_x
        dy = corner_y - origin_y
        i_values.append((dx * by - dy * bx) / determinant)
        j_values.append((dy * ax - dx * ay) / determinant)

    return (
        (ax, ay),
        (bx, by),
        origin_x,
        origin_y,
        half_width,
        half_height,
        math.floor(min(i_values) - GRID_BOUNDS_EPSILON),
        math.ceil(max(i_values) + GRID_BOUNDS_EPSILON),
        math.floor(min(j_values) - GRID_BOUNDS_EPSILON),
        math.ceil(max(j_values) + GRID_BOUNDS_EPSILON),
    )


def enumerate_visible_grid_cells(
    frame_width: int,
    frame_height: int,
    grid: GridState,
) -> list[GridCellRect]:
    (ax, ay), (bx, by), origin_x, origin_y, half_width, half_height, i_min, i_max, j_min, j_max = (
        resolve_visible_grid_index_bounds(frame_width, frame_height, grid)
    )
    cells: list[GridCellRect] = []

    for i in range(i_min, i_max + 1):
        for j in range(j_min, j_max + 1):
            center_x = origin_x + i * ax + j * bx
            center_y = origin_y + i * ay + j * by
            cell = GridCellRect(
                id=f"{i}:{j}",
                x=center_x - half_width,
                y=center_y - half_height,
                width=float(grid["cellWidth"]),
                height=float(grid["cellHeight"]),
            )
            if (
                cell.x + cell.width >= 0
                and cell.y + cell.height >= 0
                and cell.x <= frame_width
                and cell.y <= frame_height
            ):
                cells.append(cell)

    return cells


def find_grid_cell_at_point(
    frame_width: int,
    frame_height: int,
    grid: GridState,
    x: float,
    y: float,
) -> GridCellRect | None:
    if not math.isfinite(x) or not math.isfinite(y):
        return None

    cells = enumerate_visible_grid_cells(frame_width, frame_height, grid)
    for cell in reversed(cells):
        if x >= cell.x and x <= cell.x + cell.width and y >= cell.y and y <= cell.y + cell.height:
            return cell
    return None


def toggle_cell_ids(
    current_cell_ids: set[str] | list[str],
    cell_ids_to_toggle: set[str] | list[str],
) -> list[str]:
    active_cell_ids = set(current_cell_ids)
    for cell_id in set(cell_ids_to_toggle):
        if cell_id in active_cell_ids:
            active_cell_ids.remove(cell_id)
        else:
            active_cell_ids.add(cell_id)
    return sorted(active_cell_ids)


def build_bbox_csv(
    frame_width: int,
    frame_height: int,
    grid: GridState,
    excluded_cell_ids: set[str] | list[str],
) -> str:
    rows = ["crop,x,y,w,h"]
    crop = 0
    excluded = set(excluded_cell_ids)
    for cell in enumerate_visible_grid_cells(frame_width, frame_height, grid):
        if cell.id in excluded:
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


def count_visible_cells(
    frame_width: int,
    frame_height: int,
    grid: GridState,
    excluded_cell_ids: set[str] | list[str],
) -> tuple[int, int]:
    cells = enumerate_visible_grid_cells(frame_width, frame_height, grid)
    excluded = set(excluded_cell_ids)
    excluded_count = sum(1 for cell in cells if cell.id in excluded)
    return len(cells) - excluded_count, excluded_count


__all__ = [
    "GridCellRect",
    "GridState",
    "build_bbox_csv",
    "count_visible_cells",
    "create_default_grid",
    "enumerate_visible_grid_cells",
    "find_grid_cell_at_point",
    "minimum_grid_spacing",
    "normalize_grid_state",
    "toggle_cell_ids",
]
