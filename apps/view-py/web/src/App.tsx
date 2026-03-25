import {
  ViewerCanvasSurface,
  createDefaultGrid,
  normalizeGridState,
  type ContrastWindow,
  type FrameResult,
  type GridState,
  type PixelType,
  type ViewerCanvasStatusMessage,
} from "@view/view";
import { useEffect, useMemo, useState } from "react";

import { installHostStateListener, sendExcludedCellsAdded, sendGridChanged, type HostCanvasState } from "./host";

interface HostFramePayload {
  width: number;
  height: number;
  dataBase64: string;
  pixelType?: PixelType;
  contrastDomain?: ContrastWindow;
  suggestedContrast?: ContrastWindow;
  appliedContrast?: ContrastWindow;
}

interface SurfaceState {
  frame: HostFramePayload | null;
  grid: GridState;
  excludedCellIds: string[];
  selectionMode: boolean;
  loading: boolean;
  emptyText: string;
  messages: ViewerCanvasStatusMessage[];
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeFrame(frame: HostFramePayload | null): FrameResult | null {
  if (!frame) return null;
  return {
    width: frame.width,
    height: frame.height,
    pixels: decodeBase64ToBytes(frame.dataBase64),
    pixelType: frame.pixelType ?? "uint8",
    contrastDomain: frame.contrastDomain,
    suggestedContrast: frame.suggestedContrast,
    appliedContrast: frame.appliedContrast,
  };
}

function normalizeMessages(messages: HostCanvasState["messages"]): ViewerCanvasStatusMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    if (typeof message.text !== "string" || !message.text) return [];
    return [
      {
        text: message.text,
        tone:
          message.tone === "error" || message.tone === "success" || message.tone === "default"
            ? message.tone
            : "default",
      },
    ];
  });
}

function mergeExcludedCellIds(current: string[], added: string[]) {
  if (added.length === 0) return current;
  const merged = new Set(current);
  let changed = false;
  for (const cellId of added) {
    if (!merged.has(cellId)) {
      merged.add(cellId);
      changed = true;
    }
  }
  return changed ? Array.from(merged).sort() : current;
}

function normalizeHostState(next: HostCanvasState): SurfaceState {
  return {
    frame:
      next.frame &&
      typeof next.frame === "object" &&
      typeof next.frame.width === "number" &&
      typeof next.frame.height === "number" &&
      typeof next.frame.dataBase64 === "string"
        ? next.frame
        : null,
    grid: normalizeGridState(next.grid ?? createDefaultGrid()),
    excludedCellIds: Array.isArray(next.excludedCellIds)
      ? next.excludedCellIds.filter((cellId): cellId is string => typeof cellId === "string")
      : [],
    selectionMode: next.selectionMode === true,
    loading: next.loading === true,
    emptyText: typeof next.emptyText === "string" ? next.emptyText : "Open a workspace to load frames",
    messages: normalizeMessages(next.messages),
  };
}

export default function App() {
  const [surfaceState, setSurfaceState] = useState<SurfaceState>(() =>
    normalizeHostState({
      frame: null,
      grid: createDefaultGrid(),
      excludedCellIds: [],
      selectionMode: false,
      loading: false,
      emptyText: "Open a workspace to load frames",
      messages: [],
    }),
  );

  useEffect(() => installHostStateListener((next) => setSurfaceState(normalizeHostState(next))), []);

  const frame = useMemo(() => decodeFrame(surfaceState.frame), [surfaceState.frame]);

  return (
    <ViewerCanvasSurface
      frame={frame}
      grid={surfaceState.grid}
      excludedCellIds={surfaceState.excludedCellIds}
      selectionMode={surfaceState.selectionMode}
      loading={surfaceState.loading}
      emptyText={surfaceState.emptyText}
      messages={surfaceState.messages}
      onGridChange={(nextGrid) => {
        setSurfaceState((current) => ({ ...current, grid: nextGrid }));
        sendGridChanged(nextGrid);
      }}
      onExcludeCells={(cellIds) => {
        if (cellIds.length === 0) return;
        setSurfaceState((current) => ({
          ...current,
          excludedCellIds: mergeExcludedCellIds(current.excludedCellIds, cellIds),
        }));
        sendExcludedCellsAdded(cellIds);
      }}
    />
  );
}
