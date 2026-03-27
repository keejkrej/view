import { useEffect, useState } from "react";

import type { GridState, ViewerBackend, ViewerSource } from "@view/view";
import { makeSourceKey, normalizeGridState } from "@view/view";

import ViewerWorkspace from "./ViewerWorkspace";

const LAST_SOURCE_KEY = "view.lastSource";
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

function parseStoredSource(raw: string | null): ViewerSource | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<ViewerSource>;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.kind === "workspace" || parsed.kind === "nd2") &&
      typeof parsed.path === "string" &&
      parsed.path
    ) {
      return { kind: parsed.kind, path: parsed.path };
    }
  } catch {
    if (raw) {
      return { kind: "workspace", path: raw };
    }
  }

  return null;
}

function readStoredSource(storage: StorageLike | null): ViewerSource | null {
  return parseStoredSource(storage?.getItem(LAST_SOURCE_KEY) ?? storage?.getItem(LAST_ROOT_KEY) ?? null);
}

function excludedBboxStorageKey(source: ViewerSource): string {
  return `${EXCLUDED_BBOX_KEY_PREFIX}:${encodeURIComponent(makeSourceKey(source))}`;
}

function readStoredExcludedCellIds(
  storage: StorageLike | null,
  source: ViewerSource | null,
): ExcludedCellIdsByPosition {
  if (!storage || !source) return {};

  try {
    let raw = storage.getItem(excludedBboxStorageKey(source));
    if (!raw && source.kind === "workspace") {
      raw = storage.getItem(`${EXCLUDED_BBOX_KEY_PREFIX}:${encodeURIComponent(source.path)}`);
    }
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

interface ViewAppProps {
  backend: ViewerBackend;
  pickWorkspace: () => Promise<string | null>;
  pickNd2: () => Promise<string | null>;
}

export default function ViewApp({ backend, pickWorkspace, pickNd2 }: ViewAppProps) {
  const storage = resolveStorage();
  const [source, setSource] = useState<ViewerSource | null>(() => readStoredSource(storage));
  const [initialGrid] = useState<GridState | undefined>(() => readStoredGrid(storage));
  const [excludedCellIdsByPosition, setExcludedCellIdsByPosition] = useState<ExcludedCellIdsByPosition>(
    () => readStoredExcludedCellIds(storage, readStoredSource(storage)),
  );

  useEffect(() => {
    if (!storage) return;
    if (source) {
      storage.setItem(LAST_SOURCE_KEY, JSON.stringify(source));
      if (source.kind === "workspace") {
        storage.setItem(LAST_ROOT_KEY, source.path);
      } else {
        storage.removeItem(LAST_ROOT_KEY);
      }
    } else {
      storage.removeItem(LAST_SOURCE_KEY);
      storage.removeItem(LAST_ROOT_KEY);
    }
  }, [source, storage]);

  useEffect(() => {
    setExcludedCellIdsByPosition(readStoredExcludedCellIds(storage, source));
  }, [source, storage]);

  useEffect(() => {
    if (!storage || !source) return;
    storage.setItem(
      excludedBboxStorageKey(source),
      JSON.stringify(excludedCellIdsByPosition),
    );
  }, [excludedCellIdsByPosition, source, storage]);

  const handlePickWorkspace = async () => {
    const selected = await pickWorkspace();
    if (selected) setSource({ kind: "workspace", path: selected });
  };

  const handlePickNd2 = async () => {
    const selected = await pickNd2();
    if (selected) setSource({ kind: "nd2", path: selected });
  };

  return (
    <ViewerWorkspace
      key={source ? makeSourceKey(source) : "no-source"}
      source={source}
      backend={backend}
      initialGrid={initialGrid}
      initialExcludedCellIdsByPosition={excludedCellIdsByPosition}
      onExcludedCellIdsChange={setExcludedCellIdsByPosition}
      onGridChange={(grid) => storage?.setItem(LAST_GRID_KEY, JSON.stringify(grid))}
      onOpenWorkspace={handlePickWorkspace}
      onOpenNd2={handlePickNd2}
      onClearSource={() => setSource(null)}
    />
  );
}
