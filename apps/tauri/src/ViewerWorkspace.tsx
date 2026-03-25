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
  applyGridWheelGesture,
  autoContrast,
  buildBboxCsv,
  clamp,
  coerceSelection,
  createDefaultGrid,
  createSelection,
  degreesToRadians,
  enumerateVisibleGridCells,
  findGridCellAtPoint,
  getFrameContrastDomain,
  gridBasis,
  makeFrameKey,
  normalizeRadians,
  normalizeGridState,
  radiansToDegrees,
  type FrameResult,
  type GridShape,
  type GridState,
  type PosViewerDataSource,
  type ViewerSelection,
  type WorkspaceScan,
} from "@view/pos-viewer";
import { saveBbox } from "./api";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { cn } from "./lib/utils";

type SelectValue = number | string;

type Option<T extends SelectValue> = {
  label: string;
  value: T;
};

type ExcludedCellIdsByPosition = Record<number, string[]>;

type SaveState =
  | { type: "idle"; message: null }
  | { type: "success"; message: string }
  | { type: "error"; message: string };

interface ViewerWorkspaceProps {
  root: string;
  dataSource: PosViewerDataSource;
  initialGrid?: Partial<GridState>;
  initialSelection?: Partial<ViewerSelection>;
  initialExcludedCellIdsByPosition?: ExcludedCellIdsByPosition;
  onGridChange?: (grid: GridState) => void;
  onExcludedCellIdsChange?: (next: ExcludedCellIdsByPosition) => void;
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
    ctx.strokeRect(scaledX + 0.5, scaledY + 0.5, Math.max(0, scaledWidth - 1), Math.max(0, scaledHeight - 1));
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
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {action}
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
  initialExcludedCellIdsByPosition,
  onGridChange,
  onExcludedCellIdsChange,
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
  const contrastMinRef = useRef(0);
  const contrastMaxRef = useRef(1);
  const autoContrastPendingRef = useRef(true);
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

  const [scan, setScan] = useState<WorkspaceScan | null>(null);
  const [selection, setSelection] = useState<ViewerSelection | null>(null);
  const [grid, setGrid] = useState<GridState>(() => normalizeGridState(initialGrid));
  const [frame, setFrame] = useState<FrameResult | null>(null);
  const [preparedFrame, setPreparedFrame] = useState<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contrastMin, setContrastMin] = useState(0);
  const [contrastMax, setContrastMax] = useState(1);
  const [autoContrastPending, setAutoContrastPending] = useState(true);
  const [timeSliderIndex, setTimeSliderIndex] = useState(0);
  const [selectionMode, setSelectionMode] = useState(false);
  const [excludedCellIdsByPosition, setExcludedCellIdsByPosition] = useState<ExcludedCellIdsByPosition>(
    () => initialExcludedCellIdsByPosition ?? {},
  );
  const [saveState, setSaveState] = useState<SaveState>({ type: "idle", message: null });
  const [saving, setSaving] = useState(false);

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
      const activeSelection = selection;
      const activeExcluded = new Set(
        activeSelection ? excludedCellIdsByPosition[activeSelection.pos] ?? [] : [],
      );
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
        drawGridOverlay(ctx, cssWidth, cssHeight, cached.frame, activeGrid, activeExcluded);
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
  }, [excludedCellIdsByPosition, loading, selection]);

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
    contrastMinRef.current = contrastMin;
    contrastMaxRef.current = contrastMax;
  }, [contrastMax, contrastMin]);

  useEffect(() => {
    autoContrastPendingRef.current = autoContrastPending;
  }, [autoContrastPending]);

  useEffect(() => {
    onGridChange?.(grid);
  }, [grid, onGridChange]);

  useEffect(() => {
    onExcludedCellIdsChange?.(excludedCellIdsByPosition);
  }, [excludedCellIdsByPosition, onExcludedCellIdsChange]);

  useEffect(() => {
    if (!root) {
      setLoading(false);
      setError(null);
      setFrame(null);
      setPreparedFrame(null);
      setScan(null);
      setSelection(null);
      setAutoContrastPending(true);
      setSelectionMode(false);
      setSaveState({ type: "idle", message: null });
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setFrame(null);
    setScan(null);
    setSelection(null);
    setAutoContrastPending(true);

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
    const applyContrastForFrame = (nextFrame: FrameResult) => {
      if (autoContrastPendingRef.current) {
        const autoWindow = autoContrast(nextFrame.pixels);
        const nextContrast = clampContrastWindow(nextFrame, autoWindow.min, autoWindow.max);
        setContrastMin(nextContrast.min);
        setContrastMax(nextContrast.max);
        setAutoContrastPending(false);
        return;
      }

      const nextContrast = clampContrastWindow(
        nextFrame,
        contrastMinRef.current,
        contrastMaxRef.current,
      );
      setContrastMin(nextContrast.min);
      setContrastMax(nextContrast.max);
    };

    const cached = frameCacheRef.current.get(key);
    if (cached) {
      setFrame(cached.frame);
      setError(null);
      applyContrastForFrame(cached.frame);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const loaded = await dataSource.loadFrame(root, selection);
        if (cancelled) return;
        applyContrastForFrame(loaded);
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

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      if (!frame || !grid.enabled || selectionMode) return;
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
      setGrid(nextGrid);
    },
    [frame, grid.enabled, selectionMode],
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
  const activeExcludedCellIds = useMemo(
    () => new Set(selection ? excludedCellIdsByPosition[selection.pos] ?? [] : []),
    [excludedCellIdsByPosition, selection],
  );
  const visibleCells = useMemo(
    () => (frame ? enumerateVisibleGridCells(frame, grid) : []),
    [frame, grid],
  );
  const excludedVisibleCount = useMemo(
    () => visibleCells.filter((cell) => activeExcludedCellIds.has(cell.id)).length,
    [activeExcludedCellIds, visibleCells],
  );
  const includedVisibleCount = visibleCells.length - excludedVisibleCount;

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

  const addExcludedCells = useCallback((position: number, cellIds: Iterable<string>) => {
    setExcludedCellIdsByPosition((current) => {
      const active = new Set(current[position] ?? []);
      let changed = false;
      for (const cellId of cellIds) {
        if (!active.has(cellId)) {
          active.add(cellId);
          changed = true;
        }
      }
      if (!changed) return current;

      const next = { ...current };
      if (active.size === 0) {
        delete next[position];
      } else {
        next[position] = Array.from(active).sort();
      }
      return next;
    });
  }, []);

  const excludeCellsAlongStroke = useCallback(
    (
      position: number,
      startPoint: { x: number; y: number },
      endPoint: { x: number; y: number },
      activeFrame: FrameResult,
      activeGrid: GridState,
    ) => {
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
        addExcludedCells(position, hitCellIds);
      }
    },
    [addExcludedCells],
  );

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (selectionMode && event.button === 0 && frame && selection) {
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
        excludeCellsAlongStroke(selection.pos, point, point, frame, latestGridRef.current);
        event.preventDefault();
        return;
      }

      if (selectionMode) {
        event.preventDefault();
        return;
      }

      beginDrag(event);
    },
    [beginDrag, excludeCellsAlongStroke, frame, getFramePoint, selection, selectionMode],
  );

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (selectionMode) {
        const stroke = selectStrokeRef.current;
        if (!stroke || stroke.pointerId !== event.pointerId || !frame || !selection) {
          event.preventDefault();
          return;
        }

        const point = getFramePoint(event);
        if (!point) {
          event.preventDefault();
          return;
        }

        excludeCellsAlongStroke(selection.pos, stroke.lastPoint, point, frame, latestGridRef.current);
        selectStrokeRef.current = {
          pointerId: stroke.pointerId,
          lastPoint: point,
        };
        event.preventDefault();
        return;
      }

      moveDrag(event);
    },
    [excludeCellsAlongStroke, frame, getFramePoint, moveDrag, selection, selectionMode],
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

  const handleSave = useCallback(async () => {
    if (!root || !selection || !frame) return;

    setSaving(true);
    setSaveState({ type: "idle", message: null });
    try {
      const response = await saveBbox(
        root,
        selection.pos,
        buildBboxCsv(frame, grid, activeExcludedCellIds),
      );

      if (!response.ok) {
        setSaveState({ type: "error", message: response.error ?? "Failed to save bbox CSV" });
        return;
      }

      setSaveState({ type: "success", message: `Saved Pos${selection.pos}_bbox.csv` });
    } catch (nextError) {
      setSaveState({
        type: "error",
        message: nextError instanceof Error ? nextError.message : String(nextError),
      });
    } finally {
      setSaving(false);
    }
  }, [activeExcludedCellIds, frame, grid, root, selection]);

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0 flex-col">
        <header className="border-b border-border px-4 py-4 md:px-8">
          <div className="relative flex items-center gap-3">
            <div className="flex flex-wrap items-center gap-2">
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

            <p className="pointer-events-none absolute left-1/2 max-w-[min(60vw,48rem)] -translate-x-1/2 truncate text-center text-sm text-muted-foreground">
              {root || "No workspace selected"}
            </p>
          </div>
        </header>

        <main className="flex-1 min-h-0 overflow-hidden">
          <div className="grid h-full min-h-0 md:grid-cols-[16rem_minmax(0,1fr)] lg:grid-cols-[15rem_minmax(0,1fr)_16rem] lg:items-stretch xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
              <aside className="divide-y divide-border border-b border-border px-4 py-3 md:border-b-0 md:border-r lg:h-full lg:min-h-0 lg:overflow-y-auto xl:px-5">
                <PanelCard title="Image">
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

                <PanelCard
                  title="Contrast"
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!frame}
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        if (!frame) return;
                        const autoWindow = autoContrast(frame.pixels);
                        const next = clampContrastWindow(frame, autoWindow.min, autoWindow.max);
                        setContrastMin(next.min);
                        setContrastMax(next.max);
                        setAutoContrastPending(false);
                      }}
                    >
                      Auto
                    </Button>
                  }
                >
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
                </PanelCard>
              </aside>

              <section className="min-h-0 md:min-w-0 lg:h-full lg:min-h-0 lg:overflow-hidden">
                <div className="flex h-full min-h-0 flex-col overflow-hidden">
                  <div className="m-3 flex min-h-0 flex-1 overflow-hidden md:m-4 md:mt-3">
                    <div className="flex min-h-0 h-full w-full flex-1">
                      <div
                        ref={viewportRef}
                        className="relative min-h-0 h-full w-full flex-1 overflow-hidden bg-transparent"
                      >
                        <canvas
                          ref={canvasRef}
                          className={cn(
                            "block h-full w-full",
                            selectionMode
                              ? "cursor-crosshair"
                              : grid.enabled
                                ? "cursor-grab active:cursor-grabbing"
                                : "cursor-default",
                          )}
                          onPointerDown={handleCanvasPointerDown}
                        onPointerMove={handleCanvasPointerMove}
                        onPointerUp={handleCanvasPointerEnd}
                        onPointerCancel={handleCanvasPointerEnd}
                        onWheel={handleWheel}
                        onContextMenu={(event) => event.preventDefault()}
                      />

                        <div className="pointer-events-none absolute left-3 top-3 flex max-w-[78%] flex-wrap gap-1.5">
                          {error ? (
                            <div className="rounded-lg border border-destructive/30 bg-card px-3 py-2 text-sm text-destructive">
                              {error}
                            </div>
                          ) : null}
                          {saveState.message ? (
                            <div
                              className={cn(
                                "rounded-lg border bg-card px-3 py-2 text-sm",
                                saveState.type === "error"
                                  ? "border-destructive/30 text-destructive"
                                  : "border-emerald-500/30 text-emerald-300",
                              )}
                            >
                              {saveState.message}
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
                  </div>
                </div>
              </section>

              <aside className="divide-y divide-border border-t border-border px-4 py-3 lg:h-full lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l xl:px-5">
                <PanelCard
                  title="Grid"
                  action={
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        disabled={controlsDisabled}
                        onClick={() =>
                          setGrid((current) => ({
                            ...createDefaultGrid(),
                            enabled: current.enabled,
                          }))
                        }
                      >
                        Reset
                      </Button>
                      <Button
                        size="sm"
                        variant={grid.enabled ? "default" : "outline"}
                        className="h-7 min-w-12 px-2.5 text-xs"
                        disabled={controlsDisabled}
                        onClick={() =>
                          setGrid((current) => ({ ...current, enabled: !current.enabled }))
                        }
                      >
                        {grid.enabled ? "On" : "Off"}
                      </Button>
                    </div>
                  }
                >

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

                </PanelCard>

                <PanelCard
                  title="Select"
                  action={
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        disabled={!frame || !selection || saving}
                        onClick={() => void handleSave()}
                      >
                        {saving ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant={selectionMode ? "default" : "outline"}
                        className="h-7 min-w-12 px-2.5 text-xs"
                        disabled={controlsDisabled || !frame || !grid.enabled}
                        onClick={() => setSelectionMode((current) => !current)}
                      >
                        {selectionMode ? "On" : "Off"}
                      </Button>
                    </div>
                  }
                >
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Included">
                      <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-blue-300">
                        {includedVisibleCount}
                      </div>
                    </Field>
                    <Field label="Excluded">
                      <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-rose-300">
                        {excludedVisibleCount}
                      </div>
                    </Field>
                  </div>
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
