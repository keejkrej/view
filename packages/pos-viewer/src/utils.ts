import type { FrameResult, GridShape, GridState, PixelArray, PixelType, ViewerSelection, WorkspaceScan } from "./types";

export const MAX_GRID_RECTS = 8000;
const SAMPLE_SIZE = 2048;
const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 320;
const TOUCHPAD_STEP_THRESHOLD_PX = 48;
const EXP_SCALE_FACTOR = 0.0015;

export interface GridWheelGestureInput {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
}

export interface GridWheelViewport {
  displayWidth: number;
  displayHeight: number;
  modelWidth: number;
  modelHeight: number;
}

export interface GridCellRect {
  id: string;
  i: number;
  j: number;
  centerX: number;
  centerY: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GridWheelIntent = "pan" | "rotate" | "size" | "spacing";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeWheelDelta(value: number, deltaMode: number): number {
  if (!Number.isFinite(value)) return 0;
  if (deltaMode === 1) return value * LINE_DELTA_PX;
  if (deltaMode === 2) return value * PAGE_DELTA_PX;
  return value;
}

function hasFractionalWheelDelta(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  return Math.abs(value - Math.trunc(value)) > 0.001;
}

function scaleFactorFromDelta(delta: number): number {
  return Math.exp(-delta * EXP_SCALE_FACTOR);
}

export function createDefaultGrid(): GridState {
  return {
    enabled: false,
    shape: "square",
    tx: 0,
    ty: 0,
    rotation: 0,
    spacingA: 96,
    spacingB: 96,
    cellWidth: 72,
    cellHeight: 72,
    opacity: 0.35,
  };
}

export function normalizeGridState(input?: Partial<GridState>): GridState {
  const base = createDefaultGrid();
  if (!input) return base;
  return {
    enabled: input.enabled ?? base.enabled,
    shape: input.shape ?? base.shape,
    tx: input.tx ?? base.tx,
    ty: input.ty ?? base.ty,
    rotation: input.rotation ?? base.rotation,
    spacingA: Math.max(1, input.spacingA ?? base.spacingA),
    spacingB: Math.max(1, input.spacingB ?? base.spacingB),
    cellWidth: Math.max(1, input.cellWidth ?? base.cellWidth),
    cellHeight: Math.max(1, input.cellHeight ?? base.cellHeight),
    opacity: clamp(input.opacity ?? base.opacity, 0, 1),
  };
}

export function createSelection(scan: WorkspaceScan, initial?: Partial<ViewerSelection>): ViewerSelection {
  return {
    pos: initial?.pos ?? scan.positions[0] ?? 0,
    channel: initial?.channel ?? scan.channels[0] ?? 0,
    time: initial?.time ?? scan.times[0] ?? 0,
    z: initial?.z ?? scan.zSlices[0] ?? 0,
  };
}

export function coerceSelection(
  scan: WorkspaceScan,
  selection: ViewerSelection,
): ViewerSelection {
  return {
    pos: scan.positions.includes(selection.pos) ? selection.pos : (scan.positions[0] ?? 0),
    channel: scan.channels.includes(selection.channel)
      ? selection.channel
      : (scan.channels[0] ?? 0),
    time: scan.times.includes(selection.time) ? selection.time : (scan.times[0] ?? 0),
    z: scan.zSlices.includes(selection.z) ? selection.z : (scan.zSlices[0] ?? 0),
  };
}

export function gridBasis(shape: GridShape, rotation: number, spacingA: number, spacingB: number) {
  const secondAngle = rotation + (shape === "square" ? Math.PI / 2 : Math.PI / 3);
  return {
    a: {
      x: Math.cos(rotation) * spacingA,
      y: Math.sin(rotation) * spacingA,
    },
    b: {
      x: Math.cos(secondAngle) * spacingB,
      y: Math.sin(secondAngle) * spacingB,
    },
  };
}

export function estimateGridDraw(
  width: number,
  height: number,
  spacingA: number,
  spacingB: number,
  maxRects = MAX_GRID_RECTS,
) {
  const minSpacing = Math.max(1, Math.min(spacingA, spacingB));
  const maxDim = Math.max(width, height) * 2;
  const range = Math.ceil(maxDim / minSpacing) + 2;
  const estimated = (range * 2 + 1) ** 2;
  const stride = estimated > maxRects ? Math.ceil(Math.sqrt(estimated / maxRects)) : 1;
  return {
    range,
    estimated,
    stride,
    capped: stride > 1,
  };
}

function intersectsFrame(cell: GridCellRect, frameWidth: number, frameHeight: number): boolean {
  return (
    cell.x + cell.width >= 0 &&
    cell.y + cell.height >= 0 &&
    cell.x <= frameWidth &&
    cell.y <= frameHeight
  );
}

export function enumerateVisibleGridCells(frame: FrameResult, grid: GridState): GridCellRect[] {
  const drawStats = estimateGridDraw(frame.width, frame.height, grid.spacingA, grid.spacingB);
  const basis = gridBasis(grid.shape, grid.rotation, grid.spacingA, grid.spacingB);
  const originX = frame.width / 2 + grid.tx;
  const originY = frame.height / 2 + grid.ty;
  const halfWidth = grid.cellWidth / 2;
  const halfHeight = grid.cellHeight / 2;
  const cells: GridCellRect[] = [];

  for (let i = -drawStats.range; i <= drawStats.range; i += drawStats.stride) {
    for (let j = -drawStats.range; j <= drawStats.range; j += drawStats.stride) {
      const centerX = originX + i * basis.a.x + j * basis.b.x;
      const centerY = originY + i * basis.a.y + j * basis.b.y;
      const cell = {
        id: `${i}:${j}`,
        i,
        j,
        centerX,
        centerY,
        x: centerX - halfWidth,
        y: centerY - halfHeight,
        width: grid.cellWidth,
        height: grid.cellHeight,
      };

      if (intersectsFrame(cell, frame.width, frame.height)) {
        cells.push(cell);
      }
    }
  }

  return cells;
}

export function findGridCellAtPoint(
  frame: FrameResult,
  grid: GridState,
  x: number,
  y: number,
): GridCellRect | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const cells = enumerateVisibleGridCells(frame, grid);
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const cell = cells[index];
    if (
      cell &&
      x >= cell.x &&
      x <= cell.x + cell.width &&
      y >= cell.y &&
      y <= cell.y + cell.height
    ) {
      return cell;
    }
  }

  return null;
}

export function buildBboxCsv(
  frame: FrameResult,
  grid: GridState,
  excludedCellIds?: Iterable<string>,
): string {
  const excluded = excludedCellIds ? new Set(excludedCellIds) : new Set<string>();
  const rows = ["crop,x,y,w,h"];
  let crop = 0;

  for (const cell of enumerateVisibleGridCells(frame, grid)) {
    if (excluded.has(cell.id)) continue;

    const clippedX = clamp(Math.round(cell.x), 0, frame.width);
    const clippedY = clamp(Math.round(cell.y), 0, frame.height);
    const clippedRight = clamp(Math.round(cell.x + cell.width), 0, frame.width);
    const clippedBottom = clamp(Math.round(cell.y + cell.height), 0, frame.height);
    const clippedWidth = clippedRight - clippedX;
    const clippedHeight = clippedBottom - clippedY;

    if (clippedWidth <= 0 || clippedHeight <= 0) continue;

    rows.push(`${crop},${clippedX},${clippedY},${clippedWidth},${clippedHeight}`);
    crop += 1;
  }

  return rows.join("\n");
}

function sampledValues(values: PixelArray): number[] {
  if (values.length <= SAMPLE_SIZE) {
    const copy = Array.from(values);
    copy.sort((a, b) => a - b);
    return copy;
  }
  const step = values.length / SAMPLE_SIZE;
  const sample = new Array<number>(SAMPLE_SIZE);
  for (let i = 0; i < SAMPLE_SIZE; i += 1) {
    sample[i] = values[Math.floor(i * step)] ?? 0;
  }
  sample.sort((a, b) => a - b);
  return sample;
}

export function percentile(values: PixelArray, q: number): number {
  if (values.length === 0) return 0;
  const sorted = sampledValues(values);
  const clampedQ = clamp(q, 0, 1);
  const index = Math.floor(clampedQ * (sorted.length - 1));
  return sorted[index] ?? 0;
}

export function autoContrast(values: PixelArray) {
  if (values.length === 0) {
    return { min: 0, max: 1 };
  }
  const min = percentile(values, 0.001);
  const max = percentile(values, 0.999);
  return {
    min,
    max: Math.max(min + 1, max),
  };
}

function inferPixelType(values: PixelArray): PixelType | null {
  if (values instanceof Uint8Array) return "uint8";
  if (values instanceof Uint8ClampedArray) return "uint8clamped";
  if (values instanceof Int8Array) return "int8";
  if (values instanceof Uint16Array) return "uint16";
  if (values instanceof Int16Array) return "int16";
  if (values instanceof Uint32Array) return "uint32";
  if (values instanceof Int32Array) return "int32";
  return null;
}

export function getFrameContrastDomain(frame: FrameResult) {
  const pixelType = frame.pixelType ?? inferPixelType(frame.pixels);
  switch (pixelType) {
    case "uint8":
    case "uint8clamped":
      return { min: 0, max: 255 };
    case "int8":
      return { min: -128, max: 127 };
    case "uint16":
      return { min: 0, max: 65535 };
    case "int16":
      return { min: -32768, max: 32767 };
    case "uint32":
      return { min: 0, max: 4294967295 };
    case "int32":
      return { min: -2147483648, max: 2147483647 };
    default:
      return { min: 0, max: Math.max(1, Math.ceil(percentile(frame.pixels, 1))) };
  }
}

export function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

export function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function normalizeRadians(value: number): number {
  const normalized = ((value + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return Number.isFinite(normalized) ? normalized : 0;
}

export function isTouchpadLikeGridWheelGesture(gesture: GridWheelGestureInput): boolean {
  if (gesture.deltaMode !== 0) return false;

  const absDeltaX = Math.abs(normalizeWheelDelta(gesture.deltaX, gesture.deltaMode));
  const absDeltaY = Math.abs(normalizeWheelDelta(gesture.deltaY, gesture.deltaMode));

  if (absDeltaX > 0) return true;
  if (hasFractionalWheelDelta(gesture.deltaX) || hasFractionalWheelDelta(gesture.deltaY)) return true;
  if (absDeltaY > 0 && absDeltaY < TOUCHPAD_STEP_THRESHOLD_PX) return true;
  return false;
}

export function classifyGridWheelGesture(gesture: GridWheelGestureInput): GridWheelIntent {
  if (gesture.ctrlKey) {
    return gesture.shiftKey ? "spacing" : "size";
  }
  if (isTouchpadLikeGridWheelGesture(gesture)) {
    return gesture.shiftKey ? "rotate" : "pan";
  }
  return "size";
}

export function applyGridWheelGesture(
  grid: GridState,
  gesture: GridWheelGestureInput,
  viewport: GridWheelViewport,
): GridState {
  const intent = classifyGridWheelGesture(gesture);
  const deltaX = normalizeWheelDelta(gesture.deltaX, gesture.deltaMode);
  const deltaY = normalizeWheelDelta(gesture.deltaY, gesture.deltaMode);

  if (intent === "pan") {
    const sx =
      viewport.displayWidth > 0 && viewport.modelWidth > 0
        ? viewport.displayWidth / viewport.modelWidth
        : 1;
    const sy =
      viewport.displayHeight > 0 && viewport.modelHeight > 0
        ? viewport.displayHeight / viewport.modelHeight
        : 1;
    const invSx = sx > 0 ? 1 / sx : 1;
    const invSy = sy > 0 ? 1 / sy : 1;

    return {
      ...grid,
      tx: grid.tx + deltaX * invSx,
      ty: grid.ty + deltaY * invSy,
    };
  }

  if (intent === "rotate") {
    const primaryDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
    const deltaRadians = degreesToRadians((primaryDelta / Math.max(1, viewport.displayWidth)) * 220);
    return {
      ...grid,
      rotation: normalizeRadians(grid.rotation + deltaRadians),
    };
  }

  if (intent === "spacing") {
    const factor = scaleFactorFromDelta(deltaY);
    return normalizeGridState({
      ...grid,
      spacingA: grid.spacingA * factor,
      spacingB: grid.spacingB * factor,
    });
  }

  const factor = scaleFactorFromDelta(deltaY);
  return normalizeGridState({
    ...grid,
    cellWidth: grid.cellWidth * factor,
    cellHeight: grid.cellHeight * factor,
  });
}

export function makeFrameKey(root: string, selection: ViewerSelection): string {
  return `${root}:${selection.pos}:${selection.channel}:${selection.time}:${selection.z}`;
}
