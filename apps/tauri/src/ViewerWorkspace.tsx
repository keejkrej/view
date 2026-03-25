import { Slider } from "@base-ui/react";
import {
  Aperture,
  FolderOpen,
  Grid3X3,
  Hexagon,
  Layers3,
  LoaderCircle,
  ScanSearch,
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
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
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
  eyebrow,
  icon,
  children,
}: {
  title: string;
  eyebrow?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="panel-surface overflow-hidden rounded-[24px] shadow-none">
      <CardHeader className="mb-0 flex-row items-start justify-between gap-3 border-b border-white/6 p-4 pb-3">
        <div>
          {eyebrow ? (
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <CardTitle className="mt-1 text-[0.95rem] leading-none">{title}</CardTitle>
        </div>
        {icon ? (
          <div className="metric-surface rounded-xl p-2 text-muted-foreground">{icon}</div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-4">{children}</CardContent>
    </Card>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-surface rounded-2xl px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
    </div>
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
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-4">
        <label className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          {label}
        </label>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
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
      className="flex h-7 items-center"
    >
      <Slider.Control className="relative h-1.5 w-full rounded-full bg-white/8">
        <Slider.Track className="relative h-full rounded-full">
          <Slider.Indicator className="absolute h-full rounded-full bg-primary shadow-[0_0_20px_color-mix(in_srgb,var(--primary)_45%,transparent)]" />
        </Slider.Track>
        <Slider.Thumb className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-card shadow-[0_6px_20px_rgba(0,0,0,0.28)] outline-none ring-4 ring-background/50" />
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

      const background = ctx.createLinearGradient(0, 0, cssWidth, cssHeight);
      background.addColorStop(0, "#0f1729");
      background.addColorStop(0.52, "#090f1d");
      background.addColorStop(1, "#060913");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      const glow = ctx.createRadialGradient(
        cssWidth * 0.5,
        cssHeight * 0.22,
        0,
        cssWidth * 0.5,
        cssHeight * 0.22,
        Math.max(cssWidth, cssHeight) * 0.7,
      );
      glow.addColorStop(0, "rgba(114, 92, 255, 0.18)");
      glow.addColorStop(0.45, "rgba(56, 189, 248, 0.06)");
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      ctx.fillStyle = "rgba(255,255,255,0.035)";
      for (let x = 0; x < cssWidth; x += 24) {
        ctx.fillRect(x, 0, 1, cssHeight);
      }
      for (let y = 0; y < cssHeight; y += 24) {
        ctx.fillRect(0, y, cssWidth, 1);
      }

      if (cached) {
        const scale = Math.min(cssWidth / cached.frame.width, cssHeight / cached.frame.height);
        const drawWidth = cached.frame.width * scale;
        const drawHeight = cached.frame.height * scale;
        const drawX = (cssWidth - drawWidth) / 2;
        const drawY = (cssHeight - drawHeight) / 2;
        ctx.fillStyle = "rgba(148,163,184,0.08)";
        ctx.fillRect(drawX - 14, drawY - 14, drawWidth + 28, drawHeight + 28);
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.strokeRect(drawX - 14.5, drawY - 14.5, drawWidth + 29, drawHeight + 29);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cached.prepared, drawX, drawY, drawWidth, drawHeight);
        drawGridOverlay(ctx, cssWidth, cssHeight, cached.frame, activeGrid);
      } else {
        ctx.fillStyle = "rgba(226,232,240,0.72)";
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

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-[28rem] bg-[radial-gradient(52rem_22rem_at_top,color-mix(in_srgb,var(--primary)_16%,transparent),transparent)]" />
        <div className="absolute -left-28 top-24 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute right-[-7rem] top-40 h-72 w-72 rounded-full bg-cyan-400/8 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-[1720px] flex-col px-4 py-4 md:px-6 md:py-5">
        <header className="shell-surface rounded-[28px] px-5 py-5 md:px-6 md:py-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="metric-surface rounded-full px-3 py-1 text-[10px] font-medium uppercase tracking-[0.22em] text-primary">
                  View
                </span>
                <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  Pos Workspace Viewer
                </span>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-end gap-3">
                  <h1 className="text-xl font-semibold tracking-[-0.03em] text-foreground md:text-2xl">
                    {workspaceName}
                  </h1>
                  <span className="metric-surface rounded-full px-3 py-1 text-[11px] text-muted-foreground">
                    {loading ? "Scanning workspace" : hasScan ? "Workspace ready" : "No workspace loaded"}
                  </span>
                </div>
                <p className="max-w-3xl text-sm text-muted-foreground">
                  {root
                    ? "Fixed-image alignment workspace with live grid calibration, contrast control, and fast position navigation."
                    : "Open a workspace to browse positions, inspect TIFF frames, and align the grid overlay in the main viewer."}
                </p>
                <div className="metric-surface max-w-full rounded-2xl px-3 py-2 text-[11px] text-muted-foreground">
                  <span className="block truncate font-mono">
                    {root || "No workspace selected"}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 xl:min-w-[29rem] xl:max-w-[38rem] xl:items-end">
              <div className="grid w-full gap-2 sm:grid-cols-3">
                <MetricPill label="Positions" value={String(scan?.positions.length ?? 0)} />
                <MetricPill label="Channels" value={String(scan?.channels.length ?? 0)} />
                <MetricPill label="Frame" value={dims} />
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 xl:justify-end">
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
          </div>
        </header>

        <main className="relative mt-4 flex-1">
          <div className="shell-surface rounded-[32px] p-3 md:p-4 xl:p-5">
            <div className="grid gap-4 md:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_20rem]">
              <aside className="space-y-4">
                <PanelCard title="Workspace" eyebrow="Overview" icon={<ScanSearch className="size-4" />}>
                  <div className="grid grid-cols-2 gap-3">
                    <MetricPill label="Times" value={String(scan?.times.length ?? 0)} />
                    <MetricPill label="Z slices" value={String(scan?.zSlices.length ?? 0)} />
                  </div>
                  <div className="metric-surface rounded-2xl px-3 py-3 text-sm text-muted-foreground">
                    {loading
                      ? "Scanning workspace..."
                      : hasScan
                        ? "Workspace scanned successfully. Use the controls below to navigate frames."
                        : "No workspace selected. Open a valid workspace with Pos directories and TIFF frames."}
                  </div>
                </PanelCard>

                <PanelCard title="Image Navigation" eyebrow="Frame" icon={<Layers3 className="size-4" />}>
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

                <PanelCard title="Contrast" eyebrow="Image" icon={<Aperture className="size-4" />}>
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

              <section className="min-h-[34rem]">
                <div className="viewport-surface relative flex h-full min-h-[34rem] flex-col overflow-hidden rounded-[28px]">
                  <div className="border-b border-white/6 px-4 py-3 md:px-5">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span className="metric-surface inline-flex items-center gap-2 rounded-full px-3 py-1">
                          <div
                            className={cn(
                              "size-2 rounded-full",
                              loading ? "animate-pulse bg-amber-300" : "bg-emerald-300",
                            )}
                          />
                          {loading ? "Loading" : "Ready"}
                        </span>
                        {selection ? (
                          <span className="metric-surface rounded-full px-3 py-1 text-[11px] text-muted-foreground">
                            Pos {selection.pos} · Ch {selection.channel} · T {selection.time} · Z {selection.z}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                        <span className="metric-surface rounded-full px-3 py-1">
                          {grid.enabled ? "Align mode" : "Inspect mode"}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div
                    className="relative min-h-[30rem] flex-1 overflow-hidden bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary)_8%,transparent),transparent_35%)]"
                    ref={viewportRef}
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

                    <div className="pointer-events-none absolute left-4 top-4 flex max-w-[78%] flex-wrap gap-2">
                      {error ? (
                        <div className="overlay-surface rounded-2xl border-destructive/25 px-4 py-3 text-sm text-destructive">
                          {error}
                        </div>
                      ) : null}
                      {!root ? (
                        <div className="overlay-surface rounded-2xl px-4 py-3 text-sm text-muted-foreground">
                          No workspace selected. Use “Open Workspace” to start.
                        </div>
                      ) : null}
                      {!grid.enabled && frame ? (
                        <div className="overlay-surface rounded-2xl px-4 py-3 text-sm text-muted-foreground">
                          Enable align mode to drag the grid while the image stays fixed.
                        </div>
                      ) : null}
                    </div>

                    <div className="pointer-events-none absolute bottom-4 left-4 right-4 flex flex-wrap items-end justify-between gap-3">
                      <div className="overlay-surface rounded-2xl px-4 py-3 text-sm text-muted-foreground">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                          Frame Status
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          {loading ? <LoaderCircle className="size-4 animate-spin text-primary" /> : null}
                          <span>{loading ? "Loading frame..." : frame ? dims : "Idle"}</span>
                        </div>
                      </div>

                      <div className="overlay-surface rounded-2xl px-4 py-3 text-right text-sm text-muted-foreground">
                        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                          Grid
                        </div>
                        <div className="mt-1">
                          {grid.shape} · {grid.cellWidth}×{grid.cellHeight} · opacity {grid.opacity.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <aside className="space-y-4">
                <PanelCard title="Grid Alignment" eyebrow="Overlay" icon={<Grid3X3 className="size-4" />}>
                  <div className="metric-surface flex items-start justify-between gap-4 rounded-2xl px-3 py-3">
                    <div>
                      <div className="text-sm font-medium text-foreground">Align grid</div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Drag directly on the image canvas to move the overlay.
                      </p>
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

                  <div className="grid grid-cols-2 gap-3">
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

                  <div className="grid grid-cols-2 gap-3">
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

                  <div className="grid grid-cols-2 gap-3">
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

                <PanelCard title="Overlay Notes" eyebrow="Reference" icon={<Hexagon className="size-4" />}>
                  <div className="metric-surface space-y-3 rounded-2xl px-3 py-3 text-sm text-muted-foreground">
                    <p>
                      The image remains fixed while align mode is enabled. Pointer drag only updates the grid translation.
                    </p>
                    <p>
                      Orange marks the first spacing vector, green marks the second, matching the calibration affordance used in the reference tools.
                    </p>
                  </div>
                </PanelCard>
              </aside>
            </div>
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
