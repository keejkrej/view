import { Slider } from "@base-ui/react";
import {
  FolderOpen,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  type FrameResult,
  type GridShape,
  type GridState,
  type PosViewerDataSource,
  type ViewerSelection,
  type WorkspaceScan,
} from "@view/pos-viewer";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import { cn } from "./lib/utils";

type SelectValue = number | string;

type Option<T extends SelectValue> = {
  label: string;
  value: T;
};

interface ViewerWorkspaceProps {
  root: string;
  dataSource: PosViewerDataSource;
  initialGrid?: Partial<GridState>;
  initialSelection?: Partial<ViewerSelection>;
  onGridChange?: (grid: GridState) => void;
  onOpenWorkspace: () => Promise<void>;
  onClearWorkspace: () => void;
}

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

function workspaceNameFromPath(root: string) {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
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

  ctx.fillStyle = `rgba(68, 151, 255, ${grid.opacity * 0.55})`;
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

function PanelCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {hint ? <span className="text-xs text-muted-foreground/80">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  disabled,
  step = "1",
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  step?: string;
}) {
  return (
    <Input
      type="number"
      size="sm"
      step={step}
      value={Number.isFinite(value) ? String(value) : ""}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
      className="text-sm"
    />
  );
}

function AppSelect<T extends SelectValue>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <Select<T>
      value={value}
      onValueChange={(next) => next != null && onChange(next)}
      items={options}
      disabled={disabled}
      modal={false}
    >
      <SelectTrigger size="sm" className="text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={String(option.value)} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AppSlider({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <Slider.Root
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={onChange}
      onValueCommitted={onCommit}
      className="flex h-6 items-center"
    >
      <Slider.Control className="relative h-1.5 w-full rounded-full bg-input">
        <Slider.Track className="relative h-full rounded-full">
          <Slider.Indicator className="absolute h-full rounded-full bg-primary" />
        </Slider.Track>
        <Slider.Thumb className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-background shadow-sm outline-none ring-2 ring-background" />
      </Slider.Control>
    </Slider.Root>
  );
}

export default function ViewerWorkspace({
  root,
  dataSource,
  initialGrid,
  initialSelection,
  onGridChange,
  onOpenWorkspace,
  onClearWorkspace,
}: ViewerWorkspaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frameCacheRef = useRef(new FrameCache());
  const renderRafRef = useRef<number | null>(null);
  const latestFrameRef = useRef<{ frame: FrameResult; prepared: HTMLCanvasElement } | null>(null);
  const latestGridRef = useRef<GridState>(normalizeGridState(initialGrid));
  const previewGridRef = useRef<GridState | null>(null);
  const dprRef = useRef(1);
  const dragRef = useRef<
    | null
    | {
        startX: number;
        startY: number;
        startTx: number;
        startTy: number;
      }
  >(null);

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
  const [viewportSize, setViewportSize] = useState(0);

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
        drawGridOverlay(ctx, cssWidth, cssHeight, cached.frame, activeGrid);
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.font = "500 14px 'DM Sans', 'Segoe UI Variable', sans-serif";
        ctx.fillText(
          !root ? "Open a workspace to load frames" : loading ? "Loading frame..." : "No frame loaded",
          28,
          42,
        );
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
    if (!root) {
      setLoading(false);
      setError(null);
      setFrame(null);
      setPreparedFrame(null);
      setScan(null);
      setSelection(null);
      return;
    }

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
      } catch (nextError) {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataSource, initialSelection, root]);

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
        frameCacheRef.current.set(key, { frame: loaded });
        setFrame(loaded);
      } catch (nextError) {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
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
  }, [frame, contrastMin, contrastMax]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const resize = () => {
      setViewportSize(Math.max(1, Math.min(stage.clientWidth, stage.clientHeight)));
    };

    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    return () => observer.disconnect();
  }, []);

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

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
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
    },
    [queueRender],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const previewGrid = previewGridRef.current;
      dragRef.current = null;
      previewGridRef.current = null;
      if (previewGrid) {
        setGrid(previewGrid);
      } else {
        queueRender();
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [queueRender],
  );

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
  const shapeOptions = useMemo<Option<GridShape>[]>(
    () => [
      { label: "Square", value: "square" },
      { label: "Hex", value: "hex" },
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

  const workspaceName = root ? workspaceNameFromPath(root) : "Pos Viewer";
  const dims = frame ? `${frame.width} x ${frame.height}` : "No frame";
  const workspaceStatus = loading ? "Scanning" : hasScan ? "Ready" : "No workspace";
  const frameSummary = loading ? "Loading frame" : frame ? dims : "No frame";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-[1720px] flex-col px-3 py-3 md:px-4 md:py-4">
        <header className="border-b border-border px-3 py-3 md:px-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-medium text-foreground md:text-xl">
                  {workspaceName}
                </h1>
                <span className="rounded-sm border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {workspaceStatus}
                </span>
              </div>
              <p className="truncate text-xs text-muted-foreground">{root || "No workspace selected"}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
              <Button size="sm" onClick={() => void onOpenWorkspace()}>
                <span className="inline-flex items-center gap-2">
                  <FolderOpen className="size-4" />
                  Open Workspace
                </span>
              </Button>
              {root ? (
                <Button size="sm" variant="outline" onClick={onClearWorkspace}>
                  <span className="inline-flex items-center gap-2">
                    <X className="size-4" />
                    Clear
                  </span>
                </Button>
              ) : null}
            </div>
          </div>
        </header>

        <main className="flex-1 min-h-0">
          <div className="grid h-full md:grid-cols-[16rem_minmax(0,1fr)] xl:min-h-0 xl:grid-cols-[16rem_minmax(0,1fr)_18rem] xl:items-stretch">
              <aside className="divide-y divide-border border-b border-border py-3 md:border-b-0 md:border-r md:pr-3 xl:h-full xl:min-h-0 xl:overflow-y-auto xl:pr-3">
                <PanelCard title="Frame">
                  <Field label="Position">
                    <AppSelect
                      value={selection?.pos ?? (positionOptions[0]?.value ?? 0)}
                      options={positionOptions}
                      disabled={controlsDisabled}
                      onChange={(value) => setSelectionKey("pos", value)}
                    />
                  </Field>
                  <Field label="Channel">
                    <AppSelect
                      value={selection?.channel ?? (channelOptions[0]?.value ?? 0)}
                      options={channelOptions}
                      disabled={controlsDisabled}
                      onChange={(value) => setSelectionKey("channel", value)}
                    />
                  </Field>
                  <Field label="Time" hint={String(displayedTime)}>
                    <AppSlider
                      value={timeSliderIndex}
                      min={0}
                      max={timeSliderMax}
                      step={1}
                      disabled={controlsDisabled || timeValues.length <= 1}
                      onChange={(nextIndex) => setTimeSliderIndex(clamp(Math.round(nextIndex), 0, timeSliderMax))}
                      onCommit={(nextIndex) => {
                        const rounded = clamp(Math.round(nextIndex), 0, timeSliderMax);
                        setTimeSliderIndex(rounded);
                        const nextTime = timeValues[rounded];
                        if (nextTime != null && nextTime !== selection?.time) {
                          setSelectionKey("time", nextTime);
                        }
                      }}
                    />
                  </Field>
                  <Field label="Z Slice">
                    <AppSelect
                      value={selection?.z ?? (zOptions[0]?.value ?? 0)}
                      options={zOptions}
                      disabled={controlsDisabled}
                      onChange={(value) => setSelectionKey("z", value)}
                    />
                  </Field>
                </PanelCard>

                <PanelCard title="Image">
                  <Field label="Minimum" hint={String(contrastMin)}>
                    <AppSlider
                      value={contrastMin}
                      min={contrastDomain.min}
                      max={contrastMinSliderMax}
                      step={1}
                      disabled={!frame}
                      onChange={(value) =>
                        setContrastMin(
                          clamp(
                            Math.round(value),
                            contrastDomain.min,
                            Math.min(contrastMinSliderMax, contrastMax - 1),
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field label="Maximum" hint={String(contrastMax)}>
                    <AppSlider
                      value={contrastMax}
                      min={contrastMaxSliderMin}
                      max={contrastDomain.max}
                      step={1}
                      disabled={!frame}
                      onChange={(value) =>
                        setContrastMax(
                          clamp(
                            Math.round(value),
                            Math.max(contrastMaxSliderMin, contrastMin + 1),
                            contrastDomain.max,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Button
                    size="sm"
                    variant="outline"
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
                </PanelCard>
              </aside>

              <section className="min-h-[30rem] md:min-w-0 xl:h-full xl:min-h-0">
                <div className="flex h-full min-h-[30rem] flex-col overflow-hidden">
                  <div className="border-b border-border px-3 py-2.5 md:px-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {selection ? (
                        <span className="truncate">
                          P {selection.pos} · C {selection.channel} · T {selection.time} · Z {selection.z}
                        </span>
                      ) : null}
                      <span>{frameSummary}</span>
                      {grid.enabled ? <span>Grid on</span> : null}
                    </div>
                  </div>

                  <Card className="m-3 flex min-h-[26rem] flex-1 overflow-hidden rounded-xl md:m-4 md:mt-3">
                    <div ref={stageRef} className="flex h-full w-full items-center justify-center p-3 md:p-4">
                      <div
                        ref={viewportRef}
                        className="relative shrink-0 overflow-hidden bg-background"
                        style={
                          viewportSize > 0
                            ? {
                                width: `${viewportSize}px`,
                                height: `${viewportSize}px`,
                              }
                            : undefined
                        }
                      >
                        <canvas
                          ref={canvasRef}
                          className={cn(
                            "block h-full w-full",
                            grid.enabled ? "cursor-grab active:cursor-grabbing" : "cursor-default",
                          )}
                          onPointerDown={beginDrag}
                          onPointerMove={moveDrag}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                          onContextMenu={(event) => event.preventDefault()}
                        />

                        <div className="pointer-events-none absolute left-3 top-3 flex max-w-[78%] flex-wrap gap-1.5">
                          {error ? (
                            <div className="rounded-lg border border-destructive/30 bg-card px-3 py-2 text-sm text-destructive">
                              {error}
                            </div>
                          ) : null}
                          {!root ? (
                            <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
                              No workspace selected. Open a workspace to start.
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </Card>
                </div>
              </section>

              <aside className="divide-y divide-border border-t border-border py-3 xl:h-full xl:min-h-0 xl:overflow-y-auto xl:border-t-0 xl:border-l xl:pl-3">
                <PanelCard title="Grid">
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">Enable grid</div>
                      <p className="truncate text-xs text-muted-foreground">Drag on the image to reposition.</p>
                    </div>
                    <Switch
                      checked={grid.enabled}
                      disabled={controlsDisabled}
                      onCheckedChange={(checked) => setGrid((current) => ({ ...current, enabled: checked }))}
                    />
                  </div>

                  <Field label="Shape">
                    <AppSelect
                      value={grid.shape}
                      options={shapeOptions}
                      disabled={controlsDisabled}
                      onChange={(value) => setGrid((current) => ({ ...current, shape: value }))}
                    />
                  </Field>

                  <Field label="Rotation" hint={`${gridDegrees.toFixed(1)}°`}>
                    <AppSlider
                      value={gridDegrees}
                      min={-180}
                      max={180}
                      step={0.1}
                      disabled={controlsDisabled}
                      onChange={(value) =>
                        setGrid((current) => ({
                          ...current,
                          rotation: degreesToRadians(value),
                        }))
                      }
                    />
                  </Field>

                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Spacing A">
                      <NumberInput
                        value={grid.spacingA}
                        disabled={controlsDisabled}
                        onChange={(value) =>
                          setGrid((current) => ({
                            ...current,
                            spacingA: Number.isFinite(value) && value > 0 ? value : 1,
                          }))
                        }
                      />
                    </Field>
                    <Field label="Spacing B">
                      <NumberInput
                        value={grid.spacingB}
                        disabled={controlsDisabled}
                        onChange={(value) =>
                          setGrid((current) => ({
                            ...current,
                            spacingB: Number.isFinite(value) && value > 0 ? value : 1,
                          }))
                        }
                      />
                    </Field>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Cell Width">
                      <NumberInput
                        value={grid.cellWidth}
                        disabled={controlsDisabled}
                        onChange={(value) =>
                          setGrid((current) => ({
                            ...current,
                            cellWidth: Number.isFinite(value) && value > 0 ? value : 1,
                          }))
                        }
                      />
                    </Field>
                    <Field label="Cell Height">
                      <NumberInput
                        value={grid.cellHeight}
                        disabled={controlsDisabled}
                        onChange={(value) =>
                          setGrid((current) => ({
                            ...current,
                            cellHeight: Number.isFinite(value) && value > 0 ? value : 1,
                          }))
                        }
                      />
                    </Field>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Offset X">
                      <NumberInput
                        value={grid.tx}
                        disabled={controlsDisabled}
                        step="0.1"
                        onChange={(value) =>
                          setGrid((current) => ({ ...current, tx: Number.isFinite(value) ? value : 0 }))
                        }
                      />
                    </Field>
                    <Field label="Offset Y">
                      <NumberInput
                        value={grid.ty}
                        disabled={controlsDisabled}
                        step="0.1"
                        onChange={(value) =>
                          setGrid((current) => ({ ...current, ty: Number.isFinite(value) ? value : 0 }))
                        }
                      />
                    </Field>
                  </div>

                  <Field label="Overlay Opacity" hint={grid.opacity.toFixed(2)}>
                    <AppSlider
                      value={grid.opacity}
                      min={0}
                      max={1}
                      step={0.01}
                      disabled={controlsDisabled}
                      onChange={(value) =>
                        setGrid((current) => ({ ...current, opacity: clamp(value, 0, 1) }))
                      }
                    />
                  </Field>

                  <Button size="sm" variant="outline" disabled={controlsDisabled} onClick={() => setGrid(createDefaultGrid())}>
                    Reset grid
                  </Button>
                </PanelCard>
              </aside>
            </div>
        </main>
      </div>
    </div>
  );
}

function toOptions(values: number[]): Option<number>[] {
  return values.map((value) => ({ value, label: String(value) }));
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
