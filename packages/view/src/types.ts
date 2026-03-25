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

export interface PosViewerDataSource {
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

export interface PosViewerProps {
  root: string;
  dataSource: PosViewerDataSource;
  initialGrid?: Partial<GridState>;
  initialSelection?: Partial<ViewerSelection>;
  onGridChange?: (grid: GridState) => void;
  onSelectionChange?: (selection: ViewerSelection) => void;
  className?: string;
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

export interface PosViewerBackend extends PosViewerDataSource {
  saveBbox(root: string, pos: number, csv: string): Promise<SaveBboxResponse>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PosViewerHost {
  pickWorkspace(): Promise<string | null>;
  storage?: StorageLike;
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
