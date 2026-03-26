import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import type {
  FrameResult,
  GridState,
  ViewerCanvasStatusTone,
  ViewerCanvasSurfaceProps,
} from "./types";
import {
  applyGridWheelGesture,
  clamp,
  degreesToRadians,
  enumerateVisibleGridCells,
  findGridCellAtPoint,
  gridBasis,
  normalizeGridState,
  normalizeRadians,
} from "./utils";

interface PreparedFrame {
  frame: FrameResult;
  prepared: HTMLCanvasElement;
}

function prepareFrameCanvas(frame: FrameResult) {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let i = 0; i < frame.pixels.length; i += 1) {
    const value = clamp(Math.round(Number(frame.pixels[i] ?? 0)), 0, 255);
    const offset = i * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }

  ctx.putImageData(new ImageData(rgba, frame.width, frame.height), 0, 0);
  return canvas;
}

function drawGridOverlay(
  ctx: CanvasRenderingContext2D,
  viewportWidth: number,
  viewportHeight: number,
  frame: FrameResult,
  grid: GridState,
  excludedCellIds: ReadonlySet<string>,
) {
  if (!grid.enabled) return;

  const scale = Math.min(viewportWidth / frame.width, viewportHeight / frame.height);
  const drawWidth = frame.width * scale;
  const drawHeight = frame.height * scale;
  const drawX = (viewportWidth - drawWidth) / 2;
  const drawY = (viewportHeight - drawHeight) / 2;
  const originX = drawX + (frame.width / 2 + grid.tx) * scale;
  const originY = drawY + (frame.height / 2 + grid.ty) * scale;
  const basis = gridBasis(grid.shape, grid.rotation, grid.spacingA, grid.spacingB);
  const scaledA = { x: basis.a.x * scale, y: basis.a.y * scale };
  const scaledB = { x: basis.b.x * scale, y: basis.b.y * scale };

  ctx.save();
  ctx.beginPath();
  ctx.rect(drawX, drawY, drawWidth, drawHeight);
  ctx.clip();

  for (const cell of enumerateVisibleGridCells(frame, grid)) {
    const color = excludedCellIds.has(cell.id) ? "244, 63, 94" : "68, 151, 255";
    ctx.fillStyle = `rgba(${color}, ${grid.opacity * 0.55})`;
    ctx.strokeStyle = `rgba(${color}, ${Math.max(0.45, grid.opacity * 0.9)})`;
    ctx.lineWidth = 1;
    const scaledX = drawX + cell.x * scale;
    const scaledY = drawY + cell.y * scale;
    const scaledWidth = cell.width * scale;
    const scaledHeight = cell.height * scale;
    ctx.fillRect(scaledX, scaledY, scaledWidth, scaledHeight);
    ctx.strokeRect(
      scaledX + 0.5,
      scaledY + 0.5,
      Math.max(0, scaledWidth - 1),
      Math.max(0, scaledHeight - 1),
    );
  }

  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(originX, originY, 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(249,115,22,0.95)";
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX + scaledA.x, originY + scaledA.y);
  ctx.stroke();

  ctx.strokeStyle = "rgba(34,197,94,0.95)";
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX + scaledB.x, originY + scaledB.y);
  ctx.stroke();

  ctx.restore();
}

function messageToneClasses(tone: ViewerCanvasStatusTone | undefined) {
  if (tone === "error") {
    return {
      borderColor: "rgba(239, 68, 68, 0.35)",
      color: "#fca5a5",
    };
  }
  if (tone === "success") {
    return {
      borderColor: "rgba(16, 185, 129, 0.35)",
      color: "#6ee7b7",
    };
  }
  return {
    borderColor: "rgba(255, 255, 255, 0.12)",
    color: "rgba(255, 255, 255, 0.72)",
  };
}

export default function ViewerCanvasSurface({
  frame,
  grid,
  excludedCellIds,
  selectionMode = false,
  loading = false,
  emptyText,
  messages,
  className,
  onGridChange,
  onExcludeCells,
}: ViewerCanvasSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const renderRafRef = useRef<number | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const latestFrameRef = useRef<PreparedFrame | null>(null);
  const latestGridRef = useRef<GridState>(grid);
  const previewGridRef = useRef<GridState | null>(null);
  const dprRef = useRef(1);
  const selectStrokeRef = useRef<
    | null
    | {
        pointerId: number;
        lastPoint: { x: number; y: number };
      }
  >(null);
  const dragRef = useRef<
    | null
    | {
        mode: "pan" | "rotate" | "spacing";
        startX: number;
        startY: number;
        startTx: number;
        startTy: number;
        startRotation: number;
        startSpacingA: number;
        startSpacingB: number;
      }
  >(null);

  const preparedFrame = useMemo(() => (frame ? prepareFrameCanvas(frame) : null), [frame]);
  const activeExcludedCellIds = useMemo(
    () => new Set(excludedCellIds ? Array.from(excludedCellIds) : []),
    [excludedCellIds],
  );

  const queueRender = useCallback(() => {
    if (renderRafRef.current != null) return;
    renderRafRef.current = window.requestAnimationFrame(() => {
      renderRafRef.current = null;
      const canvas = canvasRef.current;
      const view = viewportRef.current;
      const cached = latestFrameRef.current;
      if (!canvas || !view) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const cssWidth = view.clientWidth;
      const cssHeight = view.clientHeight;
      const activeGrid = previewGridRef.current ?? latestGridRef.current;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dprRef.current, dprRef.current);
      ctx.fillStyle = "#09090b";
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      if (cached) {
        const scale = Math.min(cssWidth / cached.frame.width, cssHeight / cached.frame.height);
        const drawWidth = cached.frame.width * scale;
        const drawHeight = cached.frame.height * scale;
        const drawX = (cssWidth - drawWidth) / 2;
        const drawY = (cssHeight - drawHeight) / 2;
        ctx.fillStyle = "rgba(255,255,255,0.03)";
        ctx.fillRect(drawX - 8, drawY - 8, drawWidth + 16, drawHeight + 16);
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.strokeRect(drawX - 8.5, drawY - 8.5, drawWidth + 17, drawHeight + 17);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cached.prepared, drawX, drawY, drawWidth, drawHeight);
        drawGridOverlay(ctx, cssWidth, cssHeight, cached.frame, activeGrid, activeExcludedCellIds);
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "500 14px 'DM Sans', 'Segoe UI Variable', sans-serif";
        ctx.fillText(
          loading ? "Loading frame..." : (emptyText ?? "No frame loaded"),
          28,
          42,
        );
      }

      ctx.restore();
    });
  }, [activeExcludedCellIds, emptyText, loading]);

  useEffect(() => {
    latestFrameRef.current =
      frame && preparedFrame
        ? {
            frame,
            prepared: preparedFrame,
          }
        : null;
    queueRender();
  }, [frame, preparedFrame, queueRender]);

  useEffect(() => {
    latestGridRef.current = grid;
    if (!dragRef.current) {
      previewGridRef.current = null;
    }
    queueRender();
  }, [grid, queueRender]);

  useEffect(() => {
    queueRender();
  }, [activeExcludedCellIds, loading, messages, emptyText, queueRender]);

  useLayoutEffect(() => {
    const view = viewportRef.current;
    const canvas = canvasRef.current;
    if (!view || !canvas) return;

    const resize = () => {
      if (resizeRafRef.current != null) {
        window.cancelAnimationFrame(resizeRafRef.current);
      }
      resizeRafRef.current = window.requestAnimationFrame(() => {
        resizeRafRef.current = null;
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.floor(view.clientWidth * dpr));
        const height = Math.max(1, Math.floor(view.clientHeight * dpr));
        dprRef.current = dpr;
        if (canvas.width !== width) {
          canvas.width = width;
        }
        if (canvas.height !== height) {
          canvas.height = height;
        }
        const cssWidth = `${view.clientWidth}px`;
        const cssHeight = `${view.clientHeight}px`;
        if (canvas.style.width !== cssWidth) {
          canvas.style.width = cssWidth;
        }
        if (canvas.style.height !== cssHeight) {
          canvas.style.height = cssHeight;
        }
        queueRender();
      });
    };

    const observer = new ResizeObserver(() => resize());
    observer.observe(view);
    resize();

    return () => {
      if (resizeRafRef.current != null) {
        window.cancelAnimationFrame(resizeRafRef.current);
      }
      observer.disconnect();
    };
  }, [queueRender]);

  const getFramePoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const cached = latestFrameRef.current;
    const view = viewportRef.current;
    if (!cached || !view) return null;

    const bounds = view.getBoundingClientRect();
    const scale = Math.min(bounds.width / cached.frame.width, bounds.height / cached.frame.height);
    const drawWidth = cached.frame.width * scale;
    const drawHeight = cached.frame.height * scale;
    const drawX = (bounds.width - drawWidth) / 2;
    const drawY = (bounds.height - drawHeight) / 2;
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;

    if (
      pointerX < drawX ||
      pointerX > drawX + drawWidth ||
      pointerY < drawY ||
      pointerY > drawY + drawHeight
    ) {
      return null;
    }

    return {
      x: (pointerX - drawX) / scale,
      y: (pointerY - drawY) / scale,
    };
  }, []);

  const excludeCellsAlongStroke = useCallback(
    (
      startPoint: { x: number; y: number },
      endPoint: { x: number; y: number },
      activeFrame: FrameResult,
      activeGrid: GridState,
    ) => {
      if (!onExcludeCells) return;

      const sampleDistance = Math.max(4, Math.min(activeGrid.cellWidth, activeGrid.cellHeight) / 4);
      const distance = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
      const steps = Math.max(1, Math.ceil(distance / sampleDistance));
      const hitCellIds = new Set<string>();

      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const x = startPoint.x + (endPoint.x - startPoint.x) * t;
        const y = startPoint.y + (endPoint.y - startPoint.y) * t;
        const cell = findGridCellAtPoint(activeFrame, activeGrid, x, y);
        if (cell) {
          hitCellIds.add(cell.id);
        }
      }

      if (hitCellIds.size > 0) {
        onExcludeCells(Array.from(hitCellIds));
      }
    },
    [onExcludeCells],
  );

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!frame || !grid.enabled) return;

      let mode: "pan" | "rotate" | "spacing" | null = null;
      if (event.button === 0) {
        mode = "pan";
      } else if (event.button === 1) {
        mode = "spacing";
      } else if (event.button === 2) {
        mode = "rotate";
      }
      if (!mode) return;

      dragRef.current = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        startTx: grid.tx,
        startTy: grid.ty,
        startRotation: grid.rotation,
        startSpacingA: grid.spacingA,
        startSpacingB: grid.spacingB,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [frame, grid.enabled, grid.rotation, grid.spacingA, grid.spacingB, grid.tx, grid.ty],
  );

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      const cached = latestFrameRef.current;
      const view = viewportRef.current;
      if (!drag || !cached || !view) return;

      const scale = Math.min(view.clientWidth / cached.frame.width, view.clientHeight / cached.frame.height);
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;

      if (drag.mode === "pan") {
        previewGridRef.current = {
          ...latestGridRef.current,
          tx: drag.startTx + deltaX / scale,
          ty: drag.startTy + deltaY / scale,
        };
      } else if (drag.mode === "rotate") {
        previewGridRef.current = {
          ...latestGridRef.current,
          rotation: normalizeRadians(
            drag.startRotation + degreesToRadians((deltaX / Math.max(1, view.clientWidth)) * 220),
          ),
        };
      } else {
        const factor = Math.max(0.01, 1 + (deltaX / Math.max(1, view.clientWidth)) * 2.5);
        previewGridRef.current = normalizeGridState({
          ...latestGridRef.current,
          spacingA: drag.startSpacingA * factor,
          spacingB: drag.startSpacingB * factor,
        });
      }

      queueRender();
    },
    [queueRender],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const previewGrid = previewGridRef.current;
      dragRef.current = null;
      previewGridRef.current = null;
      if (previewGrid) {
        onGridChange?.(previewGrid);
      } else {
        queueRender();
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [onGridChange, queueRender],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      if (!frame || !grid.enabled || selectionMode || !onGridChange) return;

      event.preventDefault();
      const view = viewportRef.current;
      const displayWidth = view?.clientWidth ?? frame.width;
      const displayHeight = view?.clientHeight ?? frame.height;
      const nextGrid = applyGridWheelGesture(
        latestGridRef.current,
        {
          deltaMode: event.deltaMode,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
        },
        {
          displayWidth,
          displayHeight,
          modelWidth: frame.width,
          modelHeight: frame.height,
        },
      );
      previewGridRef.current = null;
      onGridChange(nextGrid);
    },
    [frame, grid.enabled, onGridChange, selectionMode],
  );

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (selectionMode && event.button === 0 && frame && onExcludeCells) {
        const point = getFramePoint(event);
        if (!point) {
          event.preventDefault();
          return;
        }

        selectStrokeRef.current = {
          pointerId: event.pointerId,
          lastPoint: point,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        excludeCellsAlongStroke(point, point, frame, latestGridRef.current);
        event.preventDefault();
        return;
      }

      if (selectionMode) {
        event.preventDefault();
        return;
      }

      beginDrag(event);
    },
    [beginDrag, excludeCellsAlongStroke, frame, getFramePoint, onExcludeCells, selectionMode],
  );

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (selectionMode) {
        const stroke = selectStrokeRef.current;
        if (!stroke || stroke.pointerId !== event.pointerId || !frame) {
          event.preventDefault();
          return;
        }

        const point = getFramePoint(event);
        if (!point) {
          event.preventDefault();
          return;
        }

        excludeCellsAlongStroke(stroke.lastPoint, point, frame, latestGridRef.current);
        selectStrokeRef.current = {
          pointerId: stroke.pointerId,
          lastPoint: point,
        };
        event.preventDefault();
        return;
      }

      moveDrag(event);
    },
    [excludeCellsAlongStroke, frame, getFramePoint, moveDrag, selectionMode],
  );

  const handleCanvasPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (selectionMode) {
        const stroke = selectStrokeRef.current;
        if (stroke?.pointerId === event.pointerId) {
          selectStrokeRef.current = null;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        event.preventDefault();
        return;
      }

      endDrag(event);
    },
    [endDrag, selectionMode],
  );

  return (
    <div
      className={className}
      ref={viewportRef}
      style={{
        position: "relative",
        minHeight: 0,
        height: "100%",
        width: "100%",
        flex: "1 1 auto",
        overflow: "hidden",
        background: "transparent",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          height: "100%",
          width: "100%",
          cursor: selectionMode ? "crosshair" : grid.enabled ? "grab" : "default",
        }}
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerEnd}
        onPointerCancel={handleCanvasPointerEnd}
        onWheel={handleWheel}
        onContextMenu={(event) => event.preventDefault()}
      />

      <div
        style={{
          pointerEvents: "none",
          position: "absolute",
          left: 12,
          top: 12,
          display: "flex",
          maxWidth: "78%",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        {messages?.map((message, index) => (
          <div
            key={`${message.tone ?? "default"}:${message.text}:${index}`}
            style={{
              borderWidth: 1,
              borderStyle: "solid",
              borderRadius: 10,
              background: "rgba(17, 24, 39, 0.92)",
              padding: "8px 12px",
              fontSize: 14,
              lineHeight: 1.4,
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
              ...messageToneClasses(message.tone),
            }}
          >
            {message.text}
          </div>
        ))}
      </div>
    </div>
  );
}
