import type { FrameResult, GridState, ViewerCanvasStatusMessage } from "@view/core-ts";

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
  onToggleCells?: (cellIds: string[]) => void;
}
