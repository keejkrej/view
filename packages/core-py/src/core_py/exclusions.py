from __future__ import annotations

from collections.abc import Iterable

ExcludedCellIdsByPosition = dict[int, list[str]]


def _normalize_cell_ids(cell_ids: Iterable[str]) -> list[str]:
    return sorted(set(cell_ids))


def toggle_excluded_cell_ids(current: Iterable[str], toggled: Iterable[str]) -> list[str]:
    next_ids = set(current)
    for cell_id in set(toggled):
        if cell_id in next_ids:
            next_ids.remove(cell_id)
        else:
            next_ids.add(cell_id)
    return sorted(next_ids)


def merge_excluded_cell_ids(current: Iterable[str], additions: Iterable[str]) -> list[str]:
    return _normalize_cell_ids([*current, *additions])


def set_excluded_cell_ids_for_position(
    mapping: ExcludedCellIdsByPosition,
    position: int,
    next_cell_ids: Iterable[str],
) -> ExcludedCellIdsByPosition:
    normalized = _normalize_cell_ids(next_cell_ids)
    next_mapping = dict(mapping)
    if normalized:
        next_mapping[position] = normalized
    else:
        next_mapping.pop(position, None)
    return next_mapping


def clear_excluded_cell_ids() -> ExcludedCellIdsByPosition:
    return {}
