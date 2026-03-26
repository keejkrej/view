export interface WorkspaceScan {
  positions: number[];
  channels: number[];
  times: number[];
  zSlices: number[];
}

export type PixelType =
  | "uint8"
  | "uint8clamped"
  | "int8"
  | "uint16"
  | "int16"
  | "uint32"
  | "int32";

export type PixelArray =
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array;

export interface FrameRequest {
  pos: number;
  channel: number;
  time: number;
  z: number;
}

export interface FrameResult {
  width: number;
  height: number;
  pixels: PixelArray;
  pixelType?: PixelType;
  contrastDomain?: ContrastWindow;
  suggestedContrast?: ContrastWindow;
  appliedContrast?: ContrastWindow;
}

export interface ViewerDataSource {
  scanWorkspace(root: string): Promise<WorkspaceScan>;
  loadFrame(root: string, request: FrameRequest, options?: LoadFrameOptions): Promise<FrameResult>;
}

export type GridShape = "square" | "hex";

export interface GridState {
  enabled: boolean;
  shape: GridShape;
  tx: number;
  ty: number;
  rotation: number;
  spacingA: number;
  spacingB: number;
  cellWidth: number;
  cellHeight: number;
  opacity: number;
}

export interface ViewerSelection {
  pos: number;
  channel: number;
  time: number;
  z: number;
}

export interface ContrastWindow {
  min: number;
  max: number;
}

export interface LoadFrameOptions {
  contrast?: ContrastWindow;
}

export type ViewerCanvasStatusTone = "default" | "error" | "success";

export interface ViewerCanvasStatusMessage {
  text: string;
  tone?: ViewerCanvasStatusTone;
}

export interface SaveBboxResponse {
  ok: boolean;
  error?: string;
}

export interface ViewerBackend extends ViewerDataSource {
  saveBbox(root: string, pos: number, csv: string): Promise<SaveBboxResponse>;
}

export interface ViewerCanvasSurfaceProps {
  frame: FrameResult | null;
  grid: GridState;
  excludedCellIds?: Iterable<string>;
  selectionMode?: boolean;
  loading?: boolean;
  emptyText?: string;
  messages?: ViewerCanvasStatusMessage[];
  className?: string;
  onGridChange?: (grid: GridState) => void;
  onExcludeCells?: (cellIds: string[]) => void;
}
