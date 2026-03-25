import type { GridState, PixelType, ViewerCanvasStatusMessage } from "@view/view";

declare global {
  interface Window {
    __viewPyApplyState?: (next: unknown) => void;
  }
}

interface HostFramePayload {
  width: number;
  height: number;
  dataBase64: string;
  pixelType?: PixelType;
  contrastDomain?: { min: number; max: number };
  suggestedContrast?: { min: number; max: number };
  appliedContrast?: { min: number; max: number };
}

export interface HostCanvasState {
  frame?: HostFramePayload | null;
  grid?: Partial<GridState>;
  excludedCellIds?: string[];
  selectionMode?: boolean;
  loading?: boolean;
  emptyText?: string;
  messages?: ViewerCanvasStatusMessage[];
}
let messageId = 0;

function emitHostEvent(type: string, payload: unknown) {
  messageId += 1;
  document.title = `__viewpy__${JSON.stringify({ id: messageId, type, payload })}`;
}

export function installHostStateListener(onState: (next: HostCanvasState) => void) {
  window.__viewPyApplyState = (next) => {
    if (!next || typeof next !== "object") return;
    onState(next as HostCanvasState);
  };
  emitHostEvent("ready", null);

  return () => {
    delete window.__viewPyApplyState;
  };
}

export function sendGridChanged(grid: GridState) {
  emitHostEvent("gridChanged", grid);
}

export function sendExcludedCellsAdded(cellIds: string[]) {
  emitHostEvent("excludedCellsAdded", cellIds);
}
