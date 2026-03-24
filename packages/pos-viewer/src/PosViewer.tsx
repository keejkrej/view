import {
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Block } from "baseui/block/index";
import { Button } from "baseui/button/index";
import { Checkbox } from "baseui/checkbox/index";
import { FormControl } from "baseui/form-control/index";
import { Input } from "baseui/input/index";
import { Select } from "baseui/select/index";
import { Slider } from "baseui/slider/index";
import type { FrameResult, GridState, PosViewerProps, ViewerSelection, WorkspaceScan } from "./types";
import {
  autoContrast,
  clamp,
  coerceSelection,
  createDefaultGrid,
  createSelection,
  degreesToRadians,
  estimateGridDraw,
  getFrameContrastDomain,
  gridBasis,
  makeFrameKey,
  normalizeGridState,
  radiansToDegrees,
} from "./utils";

type SelectOption = { id: string; label: string };

interface CachedFrame {
  frame: FrameResult;
}

class FrameCache {
  private limit: number;

  private map = new Map<string, CachedFrame>();

  constructor(limit = 12) {
    this.limit = limit;
  }

  get(key: string): CachedFrame | undefined {
    const found = this.map.get(key);
    if (!found) return undefined;
    this.map.delete(key);
    this.map.set(key, found);
    return found;
  }

  set(key: string, value: CachedFrame): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const first = this.map.keys().next().value;
      if (!first) break;
      this.map.delete(first);
    }
  }
}

function prepareFrameCanvas(frame: FrameResult, contrastMin: number, contrastMax: number) {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const range = Math.max(1, contrastMax - contrastMin);
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let i = 0; i < frame.pixels.length; i += 1) {
    const raw = frame.pixels[i] ?? 0;
    const normalized = clamp((raw - contrastMin) / range, 0, 1);
    const value = Math.round(normalized * 255);
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
  const drawStats = estimateGridDraw(frame.width, frame.height, grid.spacingA, grid.spacingB);

  ctx.save();
  ctx.beginPath();
  ctx.rect(drawX, drawY, drawWidth, drawHeight);
  ctx.clip();

  ctx.fillStyle = `rgba(92, 99, 94, ${grid.opacity})`;
  const halfWidth = (grid.cellWidth * scale) / 2;
  const halfHeight = (grid.cellHeight * scale) / 2;
  for (let i = -drawStats.range; i <= drawStats.range; i += drawStats.stride) {
    for (let j = -drawStats.range; j <= drawStats.range; j += drawStats.stride) {
      const centerX = originX + i * scaledA.x + j * scaledB.x;
      const centerY = originY + i * scaledA.y + j * scaledB.y;
      if (
        centerX + halfWidth < drawX ||
        centerX - halfWidth > drawX + drawWidth ||
        centerY + halfHeight < drawY ||
        centerY - halfHeight > drawY + drawHeight
      ) {
        continue;
      }
      ctx.fillRect(centerX - halfWidth, centerY - halfHeight, halfWidth * 2, halfHeight * 2);
    }
  }

  ctx.strokeStyle = "rgba(24,24,20,0.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(originX, originY, 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(97, 71, 45, 0.9)";
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX + scaledA.x, originY + scaledA.y);
  ctx.stroke();

  ctx.strokeStyle = "rgba(61, 102, 87, 0.9)";
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX + scaledB.x, originY + scaledB.y);
  ctx.stroke();

  ctx.restore();
}

function toOptions(values: number[]): SelectOption[] {
  return values.map((value) => ({ id: String(value), label: String(value) }));
}

function findSelected(options: SelectOption[], value: number): SelectOption[] {
  const selected = options.find((option) => Number(option.id) === value);
  return selected ? [selected] : [];
}

interface SliderChangeParams {
  value: number[];
}

function numericInputValue(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
  return Number(event.target.value);
}

function clampContrastWindow(frame: FrameResult, min: number, max: number) {
  const domain = getFrameContrastDomain(frame);
  const nextMin = clamp(Math.round(min), domain.min, domain.max - 1);
  const nextMax = clamp(Math.round(max), nextMin + 1, domain.max);
  return {
    min: nextMin,
    max: nextMax,
  };
}

export function PosViewer({
  root,
  dataSource,
  initialGrid,
  initialSelection,
  onGridChange,
  onSelectionChange,
  className,
}: PosViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frameCacheRef = useRef(new FrameCache());
  const renderRafRef = useRef<number | null>(null);
  const latestFrameRef = useRef<{ frame: FrameResult; prepared: HTMLCanvasElement } | null>(null);
  const latestGridRef = useRef<GridState>(normalizeGridState(initialGrid));
  const previewGridRef = useRef<GridState | null>(null);
  const dprRef = useRef(1);
  const [scan, setScan] = useState<WorkspaceScan | null>(null);
  const [selection, setSelection] = useState<ViewerSelection | null>(null);
  const [grid, setGrid] = useState<GridState>(() => normalizeGridState(initialGrid));
  const [frame, setFrame] = useState<FrameResult | null>(null);
  const [preparedFrame, setPreparedFrame] = useState<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contrastMin, setContrastMin] = useState(0);
  const [contrastMax, setContrastMax] = useState(1);
  const [timeSliderIndex, setTimeSliderIndex] = useState(0);
  const dragRef = useRef<
    | null
    | {
        startX: number;
        startY: number;
        startTx: number;
        startTy: number;
      }
  >(null);

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
      const activeGrid = previewGridRef.current ?? latestGridRef.current;

      const cssWidth = view.clientWidth;
      const cssHeight = view.clientHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(dprRef.current, dprRef.current);
      ctx.fillStyle = "#f8f6ef";
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      if (cached) {
        const scale = Math.min(cssWidth / cached.frame.width, cssHeight / cached.frame.height);
        const drawWidth = cached.frame.width * scale;
        const drawHeight = cached.frame.height * scale;
        const drawX = (cssWidth - drawWidth) / 2;
        const drawY = (cssHeight - drawHeight) / 2;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cached.prepared, drawX, drawY, drawWidth, drawHeight);
        drawGridOverlay(ctx, cssWidth, cssHeight, cached.frame, activeGrid);
      } else {
        ctx.fillStyle = "rgba(24,24,20,0.74)";
        ctx.font = "15px sans-serif";
        ctx.fillText(loading ? "Loading frame..." : "No frame loaded", 24, 36);
      }
      ctx.restore();
    });
  }, [loading]);

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
    queueRender();
  }, [grid, queueRender]);

  useEffect(() => {
    latestGridRef.current = grid;
    if (!dragRef.current) {
      previewGridRef.current = null;
    }
  }, [grid]);

  useEffect(() => {
    onGridChange?.(grid);
  }, [grid, onGridChange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFrame(null);
    setScan(null);
    setSelection(null);

    void (async () => {
      try {
        const nextScan = await dataSource.scanWorkspace(root);
        if (cancelled) return;
        setScan(nextScan);
        setSelection(coerceSelection(nextScan, createSelection(nextScan, initialSelection)));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataSource, initialSelection, root]);

  useEffect(() => {
    if (!selection) return;
    onSelectionChange?.(selection);
  }, [selection, onSelectionChange]);

  useEffect(() => {
    if (!root || !selection) return;
    const key = makeFrameKey(root, selection);
    const cached = frameCacheRef.current.get(key);
    if (cached) {
      setFrame(cached.frame);
      setError(null);
      const autoWindow = autoContrast(cached.frame.pixels);
      const nextContrast = clampContrastWindow(cached.frame, autoWindow.min, autoWindow.max);
      setContrastMin(nextContrast.min);
      setContrastMax(nextContrast.max);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const loaded = await dataSource.loadFrame(root, selection);
        if (cancelled) return;
        const autoWindow = autoContrast(loaded.pixels);
        const nextContrast = clampContrastWindow(loaded, autoWindow.min, autoWindow.max);
        setContrastMin(nextContrast.min);
        setContrastMax(nextContrast.max);
        const nextCached = { frame: loaded };
        frameCacheRef.current.set(key, nextCached);
        setFrame(loaded);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setFrame(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataSource, root, selection]);

  useEffect(() => {
    if (!frame) return;
    setPreparedFrame(prepareFrameCanvas(frame, contrastMin, contrastMax));
  }, [frame, contrastMax, contrastMin]);

  useLayoutEffect(() => {
    const view = viewportRef.current;
    const canvas = canvasRef.current;
    if (!view || !canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      canvas.width = Math.max(1, Math.floor(view.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(view.clientHeight * dpr));
      canvas.style.width = `${view.clientWidth}px`;
      canvas.style.height = `${view.clientHeight}px`;
      queueRender();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(view);
    resize();
    return () => observer.disconnect();
  }, [queueRender]);

  const setSelectionKey = useCallback(
    <K extends keyof ViewerSelection>(key: K, value: ViewerSelection[K]) => {
      setSelection((current) => {
        if (!current) return current;
        return { ...current, [key]: value };
      });
    },
    [],
  );

  const beginDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!frame || !grid.enabled) return;
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        startTx: grid.tx,
        startTy: grid.ty,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [frame, grid.enabled, grid.tx, grid.ty],
  );

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const cached = latestFrameRef.current;
    const view = viewportRef.current;
    if (!drag || !cached || !view) return;
    const scale = Math.min(view.clientWidth / cached.frame.width, view.clientHeight / cached.frame.height);
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    previewGridRef.current = {
      ...latestGridRef.current,
      tx: drag.startTx + deltaX / scale,
      ty: drag.startTy + deltaY / scale,
    };
    queueRender();
  }, [queueRender]);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const previewGrid = previewGridRef.current;
    dragRef.current = null;
    previewGridRef.current = null;
    if (previewGrid) {
      setGrid(previewGrid);
    } else {
      queueRender();
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, [queueRender]);

  const hasScan = !!scan && scan.positions.length > 0;
  const controlsDisabled = !hasScan || !selection;
  const contrastDomain = useMemo(
    () => (frame ? getFrameContrastDomain(frame) : { min: 0, max: 2 }),
    [frame],
  );
  const contrastMinSliderMax = Math.max(contrastDomain.min + 1, contrastDomain.max) - 1;
  const contrastMaxSliderMin = Math.min(contrastDomain.max - 1, contrastDomain.min + 1);
  const gridDegrees = radiansToDegrees(grid.rotation);
  const positionOptions = useMemo(() => toOptions(scan?.positions ?? []), [scan]);
  const channelOptions = useMemo(() => toOptions(scan?.channels ?? []), [scan]);
  const zOptions = useMemo(() => toOptions(scan?.zSlices ?? []), [scan]);
  const shapeOptions = useMemo<SelectOption[]>(
    () => [
      { id: "square", label: "Square" },
      { id: "hex", label: "Hex" },
    ],
    [],
  );
  const timeValues = scan?.times ?? [];
  const selectedTimeIndex = useMemo(() => {
    if (!selection) return 0;
    const index = timeValues.indexOf(selection.time);
    return index >= 0 ? index : 0;
  }, [selection, timeValues]);
  const displayedTime = timeValues[timeSliderIndex] ?? selection?.time ?? 0;
  const timeSliderMax = Math.max(1, timeValues.length - 1);

  useEffect(() => {
    setTimeSliderIndex(selectedTimeIndex);
  }, [selectedTimeIndex]);

  return (
    <div className={`pv-root ${className ?? ""}`.trim()}>
      <aside className="pv-sidebar pv-sidebar-left">
        <Block $style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <Block>
            <Block className="pv-title">Image Navigation</Block>
            {scan && selection ? (
              <Block $style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
                <FormControl label="Position">
                  <Select
                    options={positionOptions}
                    value={findSelected(positionOptions, selection.pos)}
                    clearable={false}
                    searchable={false}
                    disabled={controlsDisabled}
                    onChange={(params: any) => {
                      const next = Number(params.value[0]?.id);
                      if (!Number.isNaN(next)) setSelectionKey("pos", next);
                    }}
                  />
                </FormControl>
                <FormControl label="Channel">
                  <Select
                    options={channelOptions}
                    value={findSelected(channelOptions, selection.channel)}
                    clearable={false}
                    searchable={false}
                    disabled={controlsDisabled}
                    onChange={(params: any) => {
                      const next = Number(params.value[0]?.id);
                      if (!Number.isNaN(next)) setSelectionKey("channel", next);
                    }}
                  />
                </FormControl>
                <FormControl label={`Time (${displayedTime})`}>
                  <Slider
                    value={[timeSliderIndex]}
                    min={0}
                    max={timeSliderMax}
                    step={1}
                    disabled={controlsDisabled || timeValues.length <= 1}
                    onChange={({ value }: SliderChangeParams) => {
                      const nextIndex = Math.round(value[0] ?? 0);
                      setTimeSliderIndex(clamp(nextIndex, 0, timeSliderMax));
                    }}
                    onFinalChange={({ value }: SliderChangeParams) => {
                      const nextIndex = clamp(Math.round(value[0] ?? 0), 0, timeSliderMax);
                      setTimeSliderIndex(nextIndex);
                      const nextTime = timeValues[nextIndex];
                      if (nextTime != null && nextTime !== selection.time) {
                        setSelectionKey("time", nextTime);
                      }
                    }}
                  />
                </FormControl>
                <FormControl label="Z Slice">
                  <Select
                    options={zOptions}
                    value={findSelected(zOptions, selection.z)}
                    clearable={false}
                    searchable={false}
                    disabled={controlsDisabled}
                    onChange={(params: any) => {
                      const next = Number(params.value[0]?.id);
                      if (!Number.isNaN(next)) setSelectionKey("z", next);
                    }}
                  />
                </FormControl>
              </Block>
            ) : (
              <Block color="contentSecondary">Select a workspace to start.</Block>
            )}
          </Block>

          <Block>
            <Block className="pv-title">Contrast</Block>
            <Block $style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
              <FormControl label={`Contrast Min (${contrastMin})`}>
                <Slider
                  value={[contrastMin]}
                  min={contrastDomain.min}
                  max={contrastMinSliderMax}
                  step={1}
                  disabled={!frame}
                  onChange={({ value }: SliderChangeParams) =>
                    setContrastMin(
                      clamp(
                        Math.round(value[0] ?? contrastDomain.min),
                        contrastDomain.min,
                        Math.min(contrastMinSliderMax, contrastMax - 1),
                      ),
                    )
                  }
                />
              </FormControl>
              <FormControl label={`Contrast Max (${contrastMax})`}>
                <Slider
                  value={[contrastMax]}
                  min={contrastMaxSliderMin}
                  max={contrastDomain.max}
                  step={1}
                  disabled={!frame}
                  onChange={({ value }: SliderChangeParams) =>
                    setContrastMax(
                      clamp(
                        Math.round(value[0] ?? contrastDomain.max),
                        Math.max(contrastMaxSliderMin, contrastMin + 1),
                        contrastDomain.max,
                      ),
                    )
                  }
                />
              </FormControl>
              <Button
                kind="secondary"
                disabled={!frame}
                onClick={() => {
                  if (!frame) return;
                  const autoWindow = autoContrast(frame.pixels);
                  const next = clampContrastWindow(frame, autoWindow.min, autoWindow.max);
                  setContrastMin(next.min);
                  setContrastMax(next.max);
                }}
              >
                Auto contrast
              </Button>
              <Block color="contentSecondary">
                Auto contrast is applied on frame load and can be recomputed here.
              </Block>
            </Block>
          </Block>

          <Block color="contentSecondary">
            {loading ? "Loading frame..." : error ? error : frame ? `${frame.width} x ${frame.height}` : "Idle"}
          </Block>
        </Block>
      </aside>

      <section className="pv-main">
        <div className="pv-viewport" ref={viewportRef}>
          <canvas
            ref={canvasRef}
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onContextMenu={(event) => event.preventDefault()}
          />
          {error ? <div className="pv-overlay pv-error">{error}</div> : null}
          {!grid.enabled && frame ? (
            <div className="pv-overlay pv-hintOverlay">Enable align mode to move the grid overlay.</div>
          ) : null}
        </div>
      </section>

      <aside className="pv-sidebar pv-sidebar-right">
        <Block $style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <Block>
            <Block className="pv-title">Grid Alignment</Block>
            <Checkbox
              checked={grid.enabled}
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setGrid((current) => ({ ...current, enabled: (event.target as HTMLInputElement).checked }))
              }
            >
              Align grid
            </Checkbox>
            <Block color="contentSecondary" marginTop="scale300">
              When align mode is on, the image stays fixed and mouse drag only moves the grid.
            </Block>
          </Block>

          <FormControl label="Shape">
            <Select
              options={shapeOptions}
              value={shapeOptions.filter((option) => option.id === grid.shape)}
              clearable={false}
              searchable={false}
              disabled={controlsDisabled}
              onChange={(params: any) => {
                const next = params.value[0]?.id;
                if (next === "square" || next === "hex") {
                  setGrid((current) => ({ ...current, shape: next }));
                }
              }}
            />
          </FormControl>

          <FormControl label={`Rotation (${gridDegrees.toFixed(1)}°)`}>
            <Slider
              value={[gridDegrees]}
              min={-180}
              max={180}
              step={0.1}
              disabled={controlsDisabled}
              onChange={({ value }: SliderChangeParams) =>
                setGrid((current) => ({
                  ...current,
                  rotation: degreesToRadians(value[0] ?? 0),
                }))
              }
            />
          </FormControl>

          <FormControl label="Spacing A">
            <Input
              type="number"
              value={String(grid.spacingA)}
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setGrid((current) => ({
                  ...current,
                  spacingA: numericInputValue(event) || 1,
                }))
              }
            />
          </FormControl>

          <FormControl label="Spacing B">
            <Input
              type="number"
              value={String(grid.spacingB)}
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setGrid((current) => ({
                  ...current,
                  spacingB: numericInputValue(event) || 1,
                }))
              }
            />
          </FormControl>

          <FormControl label="Cell Width">
            <Input
              type="number"
              value={String(grid.cellWidth)}
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setGrid((current) => ({
                  ...current,
                  cellWidth: numericInputValue(event) || 1,
                }))
              }
            />
          </FormControl>

          <FormControl label="Cell Height">
            <Input
              type="number"
              value={String(grid.cellHeight)}
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setGrid((current) => ({
                  ...current,
                  cellHeight: numericInputValue(event) || 1,
                }))
              }
            />
          </FormControl>

          <FormControl label="Offset X">
            <Input
              type="number"
              value={String(grid.tx)}
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setGrid((current) => ({
                  ...current,
                  tx: numericInputValue(event) || 0,
                }))
              }
            />
          </FormControl>

          <FormControl label="Offset Y">
            <Input
              type="number"
              value={String(grid.ty)}
              disabled={controlsDisabled}
              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setGrid((current) => ({
                  ...current,
                  ty: numericInputValue(event) || 0,
                }))
              }
            />
          </FormControl>

          <FormControl label={`Opacity (${grid.opacity.toFixed(2)})`}>
            <Slider
              value={[grid.opacity]}
              min={0}
              max={1}
              step={0.01}
              disabled={controlsDisabled}
              onChange={({ value }: SliderChangeParams) =>
                setGrid((current) => ({ ...current, opacity: clamp(value[0] ?? 0, 0, 1) }))
              }
            />
          </FormControl>

          <Button kind="secondary" disabled={controlsDisabled} onClick={() => setGrid(createDefaultGrid())}>
            Reset grid
          </Button>
        </Block>
      </aside>
    </div>
  );
}
