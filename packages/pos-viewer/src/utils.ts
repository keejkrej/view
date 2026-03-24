import type { FrameResult, GridShape, GridState, PixelArray, PixelType, ViewerSelection, WorkspaceScan } from "./types";

export const MAX_GRID_RECTS = 8000;
const SAMPLE_SIZE = 2048;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

export function makeFrameKey(root: string, selection: ViewerSelection): string {
  return `${root}:${selection.pos}:${selection.channel}:${selection.time}:${selection.z}`;
}
