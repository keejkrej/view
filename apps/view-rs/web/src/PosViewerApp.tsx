import { useEffect, useState } from "react";

import type { GridState, PosViewerBackend } from "@view/view";
import { normalizeGridState } from "@view/view";

import ViewerWorkspace from "./ViewerWorkspace";

const LAST_ROOT_KEY = "view.lastRoot";
const LAST_GRID_KEY = "view.grid";
const EXCLUDED_BBOX_KEY_PREFIX = "view.excludedBboxes";

type ExcludedCellIdsByPosition = Record<number, string[]>;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function resolveStorage(): StorageLike | null {
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  return null;
}

function readStoredGrid(storage: StorageLike | null): GridState | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(LAST_GRID_KEY);
    if (!raw) return undefined;
    return normalizeGridState(JSON.parse(raw) as Partial<GridState>);
  } catch {
    return undefined;
  }
}

function excludedBboxStorageKey(root: string): string {
  return `${EXCLUDED_BBOX_KEY_PREFIX}:${encodeURIComponent(root)}`;
}

function readStoredExcludedCellIds(
  storage: StorageLike | null,
  root: string,
): ExcludedCellIdsByPosition {
  if (!storage || !root) return {};

  try {
    const raw = storage.getItem(excludedBboxStorageKey(root));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed).flatMap(([position, value]) => {
      if (!Array.isArray(value)) return [];
      const numericPosition = Number(position);
      if (!Number.isInteger(numericPosition)) return [];
      return [
        [
          numericPosition,
          value.filter((item): item is string => typeof item === "string"),
        ] as const,
      ];
    });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

interface PosViewerAppProps {
  backend: PosViewerBackend;
  pickWorkspace: () => Promise<string | null>;
}

export default function PosViewerApp({ backend, pickWorkspace }: PosViewerAppProps) {
  const storage = resolveStorage();
  const [root, setRoot] = useState<string>(() => storage?.getItem(LAST_ROOT_KEY) ?? "");
  const [initialGrid] = useState<GridState | undefined>(() => readStoredGrid(storage));
  const [excludedCellIdsByPosition, setExcludedCellIdsByPosition] = useState<ExcludedCellIdsByPosition>(
    () => readStoredExcludedCellIds(storage, storage?.getItem(LAST_ROOT_KEY) ?? ""),
  );

  useEffect(() => {
    if (!storage) return;
    if (root) {
      storage.setItem(LAST_ROOT_KEY, root);
    } else {
      storage.removeItem(LAST_ROOT_KEY);
    }
  }, [root, storage]);

  useEffect(() => {
    setExcludedCellIdsByPosition(readStoredExcludedCellIds(storage, root));
  }, [root, storage]);

  useEffect(() => {
    if (!storage || !root) return;
    storage.setItem(
      excludedBboxStorageKey(root),
      JSON.stringify(excludedCellIdsByPosition),
    );
  }, [excludedCellIdsByPosition, root, storage]);

  const handlePickWorkspace = async () => {
    const selected = await pickWorkspace();
    if (selected) setRoot(selected);
  };

  return (
    <ViewerWorkspace
      key={root || "no-root"}
      root={root}
      backend={backend}
      initialGrid={initialGrid}
      initialExcludedCellIdsByPosition={excludedCellIdsByPosition}
      onExcludedCellIdsChange={setExcludedCellIdsByPosition}
      onGridChange={(grid) => storage?.setItem(LAST_GRID_KEY, JSON.stringify(grid))}
      onOpenWorkspace={handlePickWorkspace}
      onClearWorkspace={() => setRoot("")}
    />
  );
}
