import type { AnnotationLabel, FrameResult } from "@view/core-ts";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

interface RoiAnnotationCanvasProps {
  frame: FrameResult;
  labels: AnnotationLabel[];
  mask: Uint8Array;
  activeLabelId: string | null;
  tool: "brush" | "erase";
  brushSize: number;
  overlayOpacity: number;
  disabled?: boolean;
  className?: string;
  onStrokeStart?: () => void;
  onPreviewMaskChange: (mask: Uint8Array) => void;
  onStrokeCommit: (mask: Uint8Array) => void;
}

interface DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(color: string) {
  const value = color.trim();
  if (!value.startsWith("#")) return null;
  const hex = value.slice(1);
  if (hex.length === 3) {
    const [r, g, b] = hex.split("");
    return {
      r: Number.parseInt(`${r}${r}`, 16),
      g: Number.parseInt(`${g}${g}`, 16),
      b: Number.parseInt(`${b}${b}`, 16),
    };
  }
  if (hex.length === 6) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    };
  }
  return null;
}

function prepareFrameCanvas(frame: FrameResult) {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let index = 0; index < frame.pixels.length; index += 1) {
    const value = clamp(Math.round(Number(frame.pixels[index] ?? 0)), 0, 255);
    const offset = index * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }

  ctx.putImageData(new ImageData(rgba, frame.width, frame.height), 0, 0);
  return canvas;
}

function prepareOverlayCanvas(
  width: number,
  height: number,
  labels: AnnotationLabel[],
  mask: Uint8Array,
  opacity: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const classValue = mask[index] ?? 0;
    if (classValue <= 0) continue;
    const label = labels[classValue - 1];
    const rgb = label ? hexToRgb(label.color) : null;
    const offset = index * 4;
    rgba[offset] = rgb?.r ?? 59;
    rgba[offset + 1] = rgb?.g ?? 130;
    rgba[offset + 2] = rgb?.b ?? 246;
    rgba[offset + 3] = Math.round(clamp(opacity, 0, 1) * 255);
  }

  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

function getDrawRect(width: number, height: number, frame: FrameResult): DrawRect {
  const scale = Math.min(width / frame.width, height / frame.height);
  const drawWidth = frame.width * scale;
  const drawHeight = frame.height * scale;
  return {
    x: (width - drawWidth) / 2,
    y: (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
    scale,
  };
}

function paintCircle(mask: Uint8Array, width: number, height: number, x: number, y: number, radius: number, value: number) {
  const left = Math.max(0, Math.floor(x - radius));
  const right = Math.min(width - 1, Math.ceil(x + radius));
  const top = Math.max(0, Math.floor(y - radius));
  const bottom = Math.min(height - 1, Math.ceil(y + radius));
  const radiusSquared = radius * radius;
  for (let py = top; py <= bottom; py += 1) {
    for (let px = left; px <= right; px += 1) {
      const dx = px - x;
      const dy = py - y;
      if (dx * dx + dy * dy > radiusSquared) continue;
      mask[py * width + px] = value;
    }
  }
}

function paintStroke(
  mask: Uint8Array,
  frame: FrameResult,
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  value: number,
) {
  const distance = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  const steps = Math.max(1, Math.ceil(distance));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    paintCircle(mask, frame.width, frame.height, x, y, radius, value);
  }
}

export default function RoiAnnotationCanvas({
  frame,
  labels,
  mask,
  activeLabelId,
  tool,
  brushSize,
  overlayOpacity,
  disabled = false,
  className,
  onStrokeStart,
  onPreviewMaskChange,
  onStrokeCommit,
}: RoiAnnotationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const renderRafRef = useRef<number | null>(null);
  const frameCanvas = useMemo(() => prepareFrameCanvas(frame), [frame]);
  const overlayCanvas = useMemo(
    () => prepareOverlayCanvas(frame.width, frame.height, labels, mask, overlayOpacity),
    [frame.height, frame.width, labels, mask, overlayOpacity],
  );
  const labelIndexMap = useMemo(
    () => new Map(labels.map((label, index) => [label.id, index + 1])),
    [labels],
  );
  const strokeRef = useRef<
    | null
    | {
        pointerId: number;
        draftMask: Uint8Array;
        lastPoint: { x: number; y: number };
      }
  >(null);

  const queueRender = useCallback(() => {
    if (renderRafRef.current != null) return;
    renderRafRef.current = window.requestAnimationFrame(() => {
      renderRafRef.current = null;
      const canvas = canvasRef.current;
      const viewport = viewportRef.current;
      if (!canvas || !viewport) return;

      const dpr = window.devicePixelRatio || 1;
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#09090b";
      ctx.fillRect(0, 0, width, height);

      const drawRect = getDrawRect(width, height, frame);
      ctx.fillStyle = "rgba(255,255,255,0.03)";
      ctx.fillRect(drawRect.x - 10, drawRect.y - 10, drawRect.width + 20, drawRect.height + 20);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.strokeRect(
        drawRect.x - 10.5,
        drawRect.y - 10.5,
        drawRect.width + 21,
        drawRect.height + 21,
      );
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(frameCanvas, drawRect.x, drawRect.y, drawRect.width, drawRect.height);
      ctx.drawImage(overlayCanvas, drawRect.x, drawRect.y, drawRect.width, drawRect.height);
    });
  }, [frame, frameCanvas, overlayCanvas]);

  useEffect(() => {
    queueRender();
  }, [queueRender]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => queueRender());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [queueRender]);

  useEffect(
    () => () => {
      if (renderRafRef.current != null) {
        window.cancelAnimationFrame(renderRafRef.current);
      }
    },
    [],
  );

  const resolveFramePoint = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const viewport = viewportRef.current;
      if (!viewport) return null;
      const bounds = viewport.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const drawRect = getDrawRect(bounds.width, bounds.height, frame);
      if (
        x < drawRect.x ||
        y < drawRect.y ||
        x > drawRect.x + drawRect.width ||
        y > drawRect.y + drawRect.height
      ) {
        return null;
      }

      const frameX = clamp(Math.floor((x - drawRect.x) / drawRect.scale), 0, frame.width - 1);
      const frameY = clamp(Math.floor((y - drawRect.y) / drawRect.scale), 0, frame.height - 1);
      return { x: frameX, y: frameY };
    },
    [frame],
  );

  const commitStroke = useCallback(() => {
    const active = strokeRef.current;
    if (!active) return;
    strokeRef.current = null;
    onStrokeCommit(active.draftMask);
  }, [onStrokeCommit]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (disabled) return;
      const point = resolveFramePoint(event);
      if (!point) return;

      const nextValue =
        tool === "erase" ? 0 : (activeLabelId ? labelIndexMap.get(activeLabelId) ?? 0 : 0);
      if (tool === "brush" && nextValue === 0) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      const radius = Math.max(0.5, brushSize / 2);
      const draftMask = mask.slice();
      paintStroke(draftMask, frame, point, point, radius, nextValue);
      strokeRef.current = {
        pointerId: event.pointerId,
        draftMask,
        lastPoint: point,
      };
      onStrokeStart?.();
      onPreviewMaskChange(draftMask);
    },
    [
      activeLabelId,
      brushSize,
      disabled,
      frame,
      labelIndexMap,
      mask,
      onPreviewMaskChange,
      onStrokeStart,
      resolveFramePoint,
      tool,
    ],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const active = strokeRef.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const point = resolveFramePoint(event);
      if (!point) return;

      const nextValue =
        tool === "erase" ? 0 : (activeLabelId ? labelIndexMap.get(activeLabelId) ?? 0 : 0);
      const radius = Math.max(0.5, brushSize / 2);
      paintStroke(active.draftMask, frame, active.lastPoint, point, radius, nextValue);
      active.lastPoint = point;
      onPreviewMaskChange(active.draftMask.slice());
    },
    [activeLabelId, brushSize, frame, labelIndexMap, onPreviewMaskChange, resolveFramePoint, tool],
  );

  return (
    <div
      ref={viewportRef}
      className={`relative min-h-[20rem] overflow-hidden rounded-2xl border border-border/70 bg-black/95 ${className ?? ""}`}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none cursor-crosshair"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={commitStroke}
        onPointerCancel={commitStroke}
        onLostPointerCapture={commitStroke}
      />
    </div>
  );
}
