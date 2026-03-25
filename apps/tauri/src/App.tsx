import { useEffect, useMemo, useState } from "react";
import { normalizeGridState, type GridState } from "@view/pos-viewer";
import { pickWorkspace, tauriDataSource } from "./api";
import ViewerWorkspace from "./ViewerWorkspace";
import "./app.css";

const LAST_ROOT_KEY = "view.lastRoot";
const LAST_GRID_KEY = "view.grid";
const EXCLUDED_BBOX_KEY_PREFIX = "view.excludedBboxes";

type ExcludedCellIdsByPosition = Record<number, string[]>;

function readStoredGrid(): GridState | undefined {
  try {
    const raw = localStorage.getItem(LAST_GRID_KEY);
    if (!raw) return undefined;
    return normalizeGridState(JSON.parse(raw) as Partial<GridState>);
  } catch {
    return undefined;
  }
}

function excludedBboxStorageKey(root: string): string {
  return `${EXCLUDED_BBOX_KEY_PREFIX}:${encodeURIComponent(root)}`;
}

function readStoredExcludedCellIds(root: string): ExcludedCellIdsByPosition {
  if (!root) return {};

  try {
    const raw = localStorage.getItem(excludedBboxStorageKey(root));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed).flatMap(([position, value]) => {
      if (!Array.isArray(value)) return [];
      const numericPosition = Number(position);
      if (!Number.isInteger(numericPosition)) return [];
      return [[numericPosition, value.filter((item): item is string => typeof item === "string")]];
    });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

export default function App() {
  const [root, setRoot] = useState<string>(() => localStorage.getItem(LAST_ROOT_KEY) ?? "");
  const [initialGrid] = useState<GridState | undefined>(() => readStoredGrid());
  const [excludedCellIdsByPosition, setExcludedCellIdsByPosition] = useState<ExcludedCellIdsByPosition>(() =>
    readStoredExcludedCellIds(localStorage.getItem(LAST_ROOT_KEY) ?? ""),
  );

  useEffect(() => {
    if (root) {
      localStorage.setItem(LAST_ROOT_KEY, root);
    } else {
      localStorage.removeItem(LAST_ROOT_KEY);
    }
  }, [root]);

  useEffect(() => {
    setExcludedCellIdsByPosition(readStoredExcludedCellIds(root));
  }, [root]);

  useEffect(() => {
    if (!root) return;
    localStorage.setItem(
      excludedBboxStorageKey(root),
      JSON.stringify(excludedCellIdsByPosition),
    );
  }, [excludedCellIdsByPosition, root]);

  const dataSource = useMemo(() => tauriDataSource, []);

  const handlePickWorkspace = async () => {
    const selected = await pickWorkspace();
    if (selected) setRoot(selected);
  };

  return (
    <ViewerWorkspace
      key={root || "no-root"}
      root={root}
      dataSource={dataSource}
      initialGrid={initialGrid}
      initialExcludedCellIdsByPosition={excludedCellIdsByPosition}
      onExcludedCellIdsChange={setExcludedCellIdsByPosition}
      onGridChange={(grid) => localStorage.setItem(LAST_GRID_KEY, JSON.stringify(grid))}
      onOpenWorkspace={handlePickWorkspace}
      onClearWorkspace={() => setRoot("")}
    />
  );
}
