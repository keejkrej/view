import { FolderOpen, X } from "lucide-react";
import type { ChangeEvent } from "react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  ContrastWindow,
  FrameResult,
  GridShape,
  GridState,
  ViewerCanvasStatusMessage,
  ViewerBackend,
  ViewerSelection,
  WorkspaceScan,
} from "@view/view";
import {
  ViewerCanvasSurface,
  buildBboxCsv,
  clamp,
  coerceSelection,
  createDefaultGrid,
  createSelection,
  degreesToRadians,
  enumerateVisibleGridCells,
  getFrameContrastDomain,
  makeFrameKey,
  normalizeGridState,
  radiansToDegrees,
} from "@view/view";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
} from "@view/shared-ui";

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

type ContrastMode = "auto" | "manual";

interface ViewerWorkspaceProps {
  root: string;
  backend: ViewerBackend;
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
  private readonly limit: number;

  private readonly map = new Map<string, CachedFrame>();

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

function PanelCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
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
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-medium text-muted-foreground">{label}</label>
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
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value))}
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
      onValueChange={(next: T | null) => next != null && onChange(next)}
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
    <Slider
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={onChange}
      onValueCommitted={onCommit}
    />
  );
}

function contrastWindowForFrame(frame: FrameResult | null): ContrastWindow {
  if (!frame) return { min: 0, max: 255 };
  return frame.contrastDomain ?? getFrameContrastDomain(frame);
}

export default function ViewerWorkspace({
  root,
  backend,
  initialGrid,
  initialSelection,
  initialExcludedCellIdsByPosition,
  onGridChange,
  onExcludedCellIdsChange,
  onOpenWorkspace,
  onClearWorkspace,
}: ViewerWorkspaceProps) {
  const frameCacheRef = useRef(new FrameCache());

  const [scan, setScan] = useState<WorkspaceScan | null>(null);
  const [selection, setSelection] = useState<ViewerSelection | null>(null);
  const [grid, setGrid] = useState<GridState>(() => normalizeGridState(initialGrid));
  const [frame, setFrame] = useState<FrameResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contrastMin, setContrastMin] = useState(0);
  const [contrastMax, setContrastMax] = useState(255);
  const [contrastMode, setContrastMode] = useState<ContrastMode>("auto");
  const [contrastReloadToken, setContrastReloadToken] = useState(0);
  const [timeSliderIndex, setTimeSliderIndex] = useState(0);
  const [selectionMode, setSelectionMode] = useState(false);
  const [excludedCellIdsByPosition, setExcludedCellIdsByPosition] = useState<ExcludedCellIdsByPosition>(
    () => initialExcludedCellIdsByPosition ?? {},
  );
  const [saveState, setSaveState] = useState<SaveState>({ type: "idle", message: null });
  const [saving, setSaving] = useState(false);

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
      setScan(null);
      setSelection(null);
      setContrastMode("auto");
      setContrastMin(0);
      setContrastMax(255);
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
    setContrastMode("auto");

    void (async () => {
      try {
        const nextScan = await backend.scanWorkspace(root);
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
  }, [backend, initialSelection, root]);

  const contrastRequestKey =
    contrastMode === "auto" ? `auto:${contrastReloadToken}` : `${contrastMin}:${contrastMax}`;

  useEffect(() => {
    if (!root || !selection) return;

    const cacheKey = `${makeFrameKey(root, selection)}:${contrastRequestKey}`;
    const requestedContrast =
      contrastMode === "manual" ? { min: contrastMin, max: contrastMax } : undefined;

    const applyLoadedFrame = (loaded: FrameResult) => {
      const domain = contrastWindowForFrame(loaded);
      const applied = loaded.appliedContrast ?? loaded.suggestedContrast ?? domain;
      setContrastMin(clamp(Math.round(applied.min), domain.min, Math.max(domain.min, domain.max - 1)));
      setContrastMax(clamp(Math.round(applied.max), Math.min(domain.min + 1, domain.max), domain.max));
      setFrame(loaded);
    };

    const cached = frameCacheRef.current.get(cacheKey);
    if (cached) {
      setError(null);
      applyLoadedFrame(cached.frame);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const loaded = await backend.loadFrame(
          root,
          selection,
          requestedContrast ? { contrast: requestedContrast } : undefined,
        );
        if (cancelled) return;
        frameCacheRef.current.set(cacheKey, { frame: loaded });
        applyLoadedFrame(loaded);
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
  }, [backend, contrastMax, contrastMin, contrastMode, contrastRequestKey, root, selection]);

  const setSelectionKey = useCallback(
    <K extends keyof ViewerSelection>(key: K, value: ViewerSelection[K]) => {
      setSelection((current) => {
        if (!current) return current;
        return { ...current, [key]: value };
      });
      setSaveState({ type: "idle", message: null });
    },
    [],
  );

  const hasScan = !!scan && scan.positions.length > 0;
  const controlsDisabled = !hasScan || !selection;
  const contrastDomain = useMemo(() => contrastWindowForFrame(frame), [frame]);
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
  const timeSliderMax = Math.max(0, timeValues.length - 1);

  useEffect(() => {
    setTimeSliderIndex(selectedTimeIndex);
  }, [selectedTimeIndex]);

  useEffect(() => {
    if (!grid.enabled || !frame) {
      setSelectionMode(false);
    }
  }, [frame, grid.enabled]);

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
    setSaveState({ type: "idle", message: null });
  }, []);

  const messages = useMemo<ViewerCanvasStatusMessage[]>(() => {
    const next: ViewerCanvasStatusMessage[] = [];
    if (error) {
      next.push({ tone: "error", text: error });
    }
    if (saveState.message) {
      next.push({
        tone: saveState.type === "error" ? "error" : "success",
        text: saveState.message,
      });
    }
    return next;
  }, [error, saveState]);

  const emptyText = useMemo(() => {
    if (!root) return "Open a workspace to load frames";
    if (scan && scan.positions.length === 0) return "No frames found in workspace";
    return "No frame loaded";
  }, [root, scan]);

  const handleSave = useCallback(async () => {
    if (!root || !selection || !frame) return;

    setSaving(true);
    setSaveState({ type: "idle", message: null });
    try {
      const response = await backend.saveBbox(
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
  }, [activeExcludedCellIds, backend, frame, grid, root, selection]);

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
                      setContrastMode("auto");
                      setContrastReloadToken((current) => current + 1);
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
                    onChange={(value) => {
                      setContrastMode("manual");
                      setContrastMin(
                        clamp(
                          Math.round(value),
                          contrastDomain.min,
                          Math.min(contrastMinSliderMax, contrastMax - 1),
                        ),
                      );
                    }}
                  />
                </Field>
                <Field label="Maximum" hint={String(contrastMax)}>
                  <AppSlider
                    value={contrastMax}
                    min={contrastMaxSliderMin}
                    max={contrastDomain.max}
                    step={1}
                    disabled={!frame}
                    onChange={(value) => {
                      setContrastMode("manual");
                      setContrastMax(
                        clamp(
                          Math.round(value),
                          Math.max(contrastMaxSliderMin, contrastMin + 1),
                          contrastDomain.max,
                        ),
                      );
                    }}
                  />
                </Field>
              </PanelCard>
            </aside>

            <section className="min-h-0 md:min-w-0 lg:h-full lg:min-h-0 lg:overflow-hidden">
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <div className="m-3 flex min-h-0 flex-1 overflow-hidden md:m-4 md:mt-3">
                  <div className="flex min-h-0 h-full w-full flex-1 overflow-hidden rounded-2xl border border-border/60 bg-black/10">
                    <ViewerCanvasSurface
                      frame={frame}
                      grid={grid}
                      excludedCellIds={activeExcludedCellIds}
                      selectionMode={selectionMode}
                      loading={loading && !frame}
                      emptyText={emptyText}
                      messages={messages}
                      onGridChange={(nextGrid) => {
                        setGrid(nextGrid);
                        setSaveState({ type: "idle", message: null });
                      }}
                      onExcludeCells={(cellIds) => {
                        if (!selection || cellIds.length === 0) return;
                        addExcludedCells(selection.pos, cellIds);
                      }}
                    />
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
