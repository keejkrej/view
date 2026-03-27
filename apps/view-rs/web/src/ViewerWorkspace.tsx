import { Effect, Exit } from "effect";
import { FolderOpen, X } from "lucide-react";
import type { ChangeEvent } from "react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";

import type {
  ContrastWindow,
  FrameResult,
  ViewerCanvasStatusMessage,
  ViewerBackend,
  ViewerSource,
} from "@view/core-ts";
import {
  getFrameContrastDomain,
  makeFrameKey,
} from "@view/core-ts";
import {
  buildBboxCsv,
  clamp,
  collectEdgeCellIds,
  countVisibleCells,
  degreesToRadians,
  enumerateVisibleGridCells,
  radiansToDegrees,
  type GridShape,
} from "@view/core-ts";
import { ViewerCanvasSurface } from "@view/canvas";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
} from "@view/ui";

import {
  excludeCells,
  IDLE_SAVE_STATE,
  patchViewState,
  reloadAutoContrast,
  resetGrid,
  setGrid,
  setSaveState,
  setSaving,
  setSelectionKey,
  setSelectionMode,
  setTimeSliderIndex,
  toggleExcludedCells,
  toggleGridEnabled,
  viewStore,
} from "./viewStore";
import {
  loadFrameEffect,
  saveBboxEffect,
  scanSourceEffect,
  toErrorMessage,
} from "./viewEffects";

type SelectValue = number | string;

type Option<T extends SelectValue> = {
  label: string;
  value: T;
};

interface ViewerWorkspaceProps {
  workspacePath: string | null;
  source: ViewerSource | null;
  backend: ViewerBackend;
  onPickWorkspace: () => Promise<void>;
  onOpenTif: () => Promise<void>;
  onOpenNd2: () => Promise<void>;
  onClearSource: () => void;
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
  min,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  step?: string;
  min?: number | string;
}) {
  return (
    <Input
      type="number"
      size="sm"
      step={step}
      min={min}
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

function normalizeContrastWindow(window: ContrastWindow, domain: ContrastWindow): ContrastWindow {
  return {
    min: clamp(Math.round(window.min), domain.min, Math.max(domain.min, domain.max - 1)),
    max: clamp(Math.round(window.max), Math.min(domain.min + 1, domain.max), domain.max),
  };
}

export default function ViewerWorkspace({
  workspacePath,
  source,
  backend,
  onPickWorkspace,
  onOpenTif,
  onOpenNd2,
  onClearSource,
}: ViewerWorkspaceProps) {
  const frameCacheRef = useRef(new FrameCache());
  const {
    scan,
    selection,
    grid,
    frame,
    loading,
    error,
    contrastMin,
    contrastMax,
    contrastMode,
    contrastReloadToken,
    timeSliderIndex,
    selectionMode,
    excludedCellIdsByPosition,
    saveState,
    saving,
  } = useStore(
    viewStore,
    useShallow((state) => ({
      scan: state.scan,
      selection: state.selection,
      grid: state.grid,
      frame: state.frame,
      loading: state.loading,
      error: state.error,
      contrastMin: state.contrastMin,
      contrastMax: state.contrastMax,
      contrastMode: state.contrastMode,
      contrastReloadToken: state.contrastReloadToken,
      timeSliderIndex: state.timeSliderIndex,
      selectionMode: state.selectionMode,
      excludedCellIdsByPosition: state.excludedCellIdsByPosition,
      saveState: state.saveState,
      saving: state.saving,
    })),
  );

  useEffect(() => {
    if (!source) return;

    const abortController = new AbortController();
    patchViewState({
      loading: true,
      error: null,
      frame: null,
      scan: null,
      selection: null,
      contrastMode: "manual",
    });

    const program = scanSourceEffect(backend, source).pipe(
      Effect.tap(({ scan, selection }) =>
        Effect.sync(() => {
          patchViewState({ scan, selection });
        }),
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          patchViewState({ error: toErrorMessage(error) });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          patchViewState({ loading: false });
        }),
      ),
    );

    void Effect.runPromiseExit(program, {
      signal: abortController.signal,
    }).then((exit) => {
      if (!Exit.isFailure(exit)) return;
      if (abortController.signal.aborted) return;
      patchViewState({ error: toErrorMessage(exit.cause) });
    });

    return () => {
      abortController.abort();
    };
  }, [backend, source]);

  const contrastRequestKey =
    contrastMode === "auto" ? `auto:${contrastReloadToken}` : `${contrastMin}:${contrastMax}`;

  useEffect(() => {
    if (!source || !selection) return;

    const frameKey = makeFrameKey(source, selection);
    const cacheKey = `${frameKey}:${contrastRequestKey}`;

    const cached = frameCacheRef.current.get(cacheKey);
    if (cached) {
      const domain = contrastWindowForFrame(cached.frame);
      const applied = cached.frame.appliedContrast ?? cached.frame.suggestedContrast ?? domain;
      const nextContrast = normalizeContrastWindow(applied, domain);
      patchViewState({ error: null });
      patchViewState({
        contrastMin: nextContrast.min,
        contrastMax: nextContrast.max,
        contrastMode: "manual",
        frame: cached.frame,
      });
      return;
    }

    const abortController = new AbortController();
    patchViewState({ loading: true, error: null });

    const program = loadFrameEffect(backend, source, selection, {
      mode: contrastMode,
      min: contrastMin,
      max: contrastMax,
    }).pipe(
      Effect.tap(({ frame: loadedFrame }) =>
        Effect.sync(() => {
          frameCacheRef.current.set(cacheKey, { frame: loadedFrame });
        }),
      ),
      Effect.tap(({ frame: loadedFrame, contrastMin, contrastMax }) =>
        Effect.sync(() => {
          if (contrastMode === "auto") {
            frameCacheRef.current.set(`${frameKey}:${contrastMin}:${contrastMax}`, {
              frame: loadedFrame,
            });
          }
          patchViewState({
            contrastMin,
            contrastMax,
            contrastMode: "manual",
            frame: loadedFrame,
          });
        }),
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          patchViewState({
            error: toErrorMessage(error),
            frame: null,
          });
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          patchViewState({ loading: false });
        }),
      ),
    );

    void Effect.runPromiseExit(program, {
      signal: abortController.signal,
    }).then((exit) => {
      if (!Exit.isFailure(exit)) return;
      if (abortController.signal.aborted) return;
      patchViewState({
        error: toErrorMessage(exit.cause),
        frame: null,
      });
    });

    return () => {
      abortController.abort();
    };
  }, [backend, contrastMax, contrastMin, contrastMode, contrastRequestKey, selection, source]);

  const hasScan = !!scan && scan.positions.length > 0;
  const controlsDisabled = !hasScan || !selection;
  const contrastDomain = useMemo(() => contrastWindowForFrame(frame), [frame]);
  const contrastMinSliderMax = Math.max(contrastDomain.min + 1, contrastDomain.max) - 1;
  const contrastMaxSliderMin = Math.min(contrastDomain.max - 1, contrastDomain.min + 1);
  const [contrastDraft, setContrastDraft] = useState<ContrastWindow | null>(null);
  const gridDegrees = radiansToDegrees(grid.rotation);
  const minGridSpacing = Math.min(grid.cellWidth, grid.cellHeight);
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
    setContrastDraft({
      min: contrastMin,
      max: contrastMax,
    });
  }, [contrastMax, contrastMin]);

  const displayedContrast = contrastDraft ?? {
    min: contrastMin,
    max: contrastMax,
  };

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
  const visibleCellCounts = useMemo(
    () => (frame ? countVisibleCells(frame, grid, activeExcludedCellIds) : { included: 0, excluded: 0 }),
    [activeExcludedCellIds, frame, grid],
  );
  const excludedVisibleCount = visibleCellCounts.excluded;
  const includedVisibleCount = visibleCellCounts.included;

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
    if (!workspacePath) return "Select a workspace folder to save bbox CSVs";
    if (!source) return "Select a TIF folder or ND2 file to load frames";
    if (scan && scan.positions.length === 0) {
      return source.kind === "nd2" ? "No frames found in ND2 file" : "No frames found in TIF folder";
    }
    return "No frame loaded";
  }, [scan, source, workspacePath]);

  const handleSave = useCallback(async () => {
    if (!workspacePath || !source || !selection || !frame) return;

    setSaving(true);
    setSaveState(IDLE_SAVE_STATE);
    const exit = await Effect.runPromiseExit(
      saveBboxEffect(backend, {
        workspacePath,
        source,
        pos: selection.pos,
        csv: buildBboxCsv(frame, grid, activeExcludedCellIds),
      }),
    );

    if (Exit.isSuccess(exit)) {
      const response = exit.value;
      if (!response.ok) {
        setSaveState({ type: "error", message: response.error ?? "Failed to save bbox CSV" });
      } else {
        setSaveState({ type: "success", message: `Saved bbox CSV for Pos${selection.pos}` });
      }
      setSaving(false);
      return;
    }

    setSaveState({
      type: "error",
      message: toErrorMessage(exit.cause),
    });
    setSaving(false);
  }, [activeExcludedCellIds, backend, frame, grid, selection, source, workspacePath]);

  const handleExcludeEdgeBboxes = useCallback(() => {
    if (!frame || !selection) return;
    const edgeCellIds = collectEdgeCellIds(frame, grid);
    if (edgeCellIds.length === 0) return;
    excludeCells(selection.pos, edgeCellIds);
  }, [frame, grid, selection]);

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <div className="flex h-full min-h-0 flex-col">
        <header className="border-b border-border px-4 py-4 md:px-8">
          <div className="relative flex items-center gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void onPickWorkspace()}>
                <span className="inline-flex items-center gap-2">
                  <FolderOpen className="size-4" />
                  Workspace
                </span>
              </Button>
              <Button size="sm" variant="outline" disabled={!workspacePath} onClick={() => void onOpenTif()}>
                Open TIF
              </Button>
              <Button size="sm" variant="outline" disabled={!workspacePath} onClick={() => void onOpenNd2()}>
                Open ND2
              </Button>
              {source ? (
                <Button size="sm" variant="outline" onClick={onClearSource}>
                  <span className="inline-flex items-center gap-2">
                    <X className="size-4" />
                    Clear
                  </span>
                </Button>
              ) : null}
            </div>

            <div className="pointer-events-none absolute left-1/2 flex max-w-[min(68vw,56rem)] -translate-x-1/2 flex-col text-center text-sm text-muted-foreground">
              <p className="truncate">
                {workspacePath ? `Workspace: ${workspacePath}` : "Workspace: not selected"}
              </p>
              <p className="truncate">{source ? `Source: ${source.path}` : "Source: not selected"}</p>
            </div>
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
                    onClick={reloadAutoContrast}
                  >
                    Auto
                  </Button>
                }
              >
                <Field label="Minimum" hint={String(displayedContrast.min)}>
                  <AppSlider
                    value={displayedContrast.min}
                    min={contrastDomain.min}
                    max={contrastMinSliderMax}
                    step={1}
                    disabled={!frame}
                    onChange={(value) => {
                      setContrastDraft((current) => ({
                        min: clamp(
                          Math.round(value),
                          contrastDomain.min,
                          Math.min(contrastMinSliderMax, (current ?? displayedContrast).max - 1),
                        ),
                        max: (current ?? displayedContrast).max,
                      }));
                    }}
                    onCommit={(value) => {
                      patchViewState({
                        contrastMode: "manual",
                        contrastMin: clamp(
                          Math.round(value),
                          contrastDomain.min,
                          Math.min(contrastMinSliderMax, displayedContrast.max - 1),
                        ),
                      });
                    }}
                  />
                </Field>
                <Field label="Maximum" hint={String(displayedContrast.max)}>
                  <AppSlider
                    value={displayedContrast.max}
                    min={contrastMaxSliderMin}
                    max={contrastDomain.max}
                    step={1}
                    disabled={!frame}
                    onChange={(value) => {
                      setContrastDraft((current) => ({
                        min: (current ?? displayedContrast).min,
                        max: clamp(
                          Math.round(value),
                          Math.max(contrastMaxSliderMin, (current ?? displayedContrast).min + 1),
                          contrastDomain.max,
                        ),
                      }));
                    }}
                    onCommit={(value) => {
                      patchViewState({
                        contrastMode: "manual",
                        contrastMax: clamp(
                          Math.round(value),
                          Math.max(contrastMaxSliderMin, displayedContrast.min + 1),
                          contrastDomain.max,
                        ),
                      });
                    }}
                  />
                </Field>
              </PanelCard>
            </aside>

            <section className="min-h-0 md:min-w-0 lg:h-full lg:min-h-0 lg:overflow-hidden">
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                <div className="m-3 flex min-h-0 flex-1 overflow-hidden md:m-4 md:mt-3">
                  <div className="flex h-full min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-border/60 bg-black/10">
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
                        setSaveState(IDLE_SAVE_STATE);
                      }}
                      onToggleCells={(cellIds) => {
                        if (!selection || cellIds.length === 0) return;
                        toggleExcludedCells(selection.pos, cellIds);
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
                      disabled={!frame || !selection}
                      onClick={handleExcludeEdgeBboxes}
                    >
                      Disable Edge
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-xs"
                      disabled={controlsDisabled}
                      onClick={resetGrid}
                    >
                      Reset
                    </Button>
                    <Button
                      size="sm"
                      variant={grid.enabled ? "default" : "outline"}
                      className="h-7 min-w-12 px-2.5 text-xs"
                      disabled={controlsDisabled}
                      onClick={toggleGridEnabled}
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
                      min={minGridSpacing}
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
                      min={minGridSpacing}
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
                      disabled={!workspacePath || !frame || !selection || saving}
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
