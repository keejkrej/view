import type {
  AnnotationLabel,
  FrameResult,
  RoiFrameAnnotation,
  RoiFrameRequest,
  RoiIndexEntry,
  ViewerBackend,
} from "@view/core-ts";
import { Button, Input, Slider } from "@view/ui";
import { Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import RoiAnnotationCanvas from "./RoiAnnotationCanvas";
import { toErrorMessage } from "./viewEffects";

interface RoiAnnotationModalProps {
  workspacePath: string;
  backend: ViewerBackend;
  roi: RoiIndexEntry;
  request: RoiFrameRequest;
  frame: FrameResult;
  labels: AnnotationLabel[] | null;
  labelsLoading: boolean;
  labelsError: string | null;
  onClose: () => void;
  onLabelsChange: (labels: AnnotationLabel[]) => void;
  onSaved: (annotation: RoiFrameAnnotation) => void;
}

interface EditorSnapshot {
  classificationLabelId: string | null;
  mask: Uint8Array;
}

function createEmptyMask(width: number, height: number) {
  return new Uint8Array(width * height);
}

function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    classificationLabelId: snapshot.classificationLabelId,
    mask: snapshot.mask.slice(),
  };
}

function masksEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function snapshotsEqual(left: EditorSnapshot, right: EditorSnapshot) {
  return left.classificationLabelId === right.classificationLabelId && masksEqual(left.mask, right.mask);
}

function maskHasPixels(mask: Uint8Array) {
  return mask.some((value) => value !== 0);
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

function colorStyle(color: string, active: boolean) {
  const rgb = hexToRgb(color);
  if (!rgb) return undefined;
  return {
    borderColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${active ? 0.95 : 0.35})`,
    backgroundColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${active ? 0.18 : 0.1})`,
    color: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
  };
}

function slugifyLabelId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function decodeMaskBase64Png(
  maskBase64Png: string,
  expectedWidth: number,
  expectedHeight: number,
) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const target = new Image();
    target.onload = () => resolve(target);
    target.onerror = () => reject(new Error("Failed to decode annotation mask"));
    target.src = `data:image/png;base64,${maskBase64Png}`;
  });

  if (image.naturalWidth !== expectedWidth || image.naturalHeight !== expectedHeight) {
    throw new Error(
      `Annotation mask dimensions ${image.naturalWidth}x${image.naturalHeight} do not match ROI frame ${expectedWidth}x${expectedHeight}`,
    );
  }

  const canvas = document.createElement("canvas");
  canvas.width = expectedWidth;
  canvas.height = expectedHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to prepare annotation mask canvas");

  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, expectedWidth, expectedHeight);
  const mask = new Uint8Array(expectedWidth * expectedHeight);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = imageData.data[index * 4] ?? 0;
  }
  return mask;
}

function encodeMaskToBase64Png(mask: Uint8Array, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return Promise.reject(new Error("Failed to prepare annotation mask canvas"));
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const value = mask[index] ?? 0;
    const offset = index * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);

  return Promise.resolve(canvas.toDataURL("image/png").split(",")[1] ?? "");
}

export default function RoiAnnotationModal({
  workspacePath,
  backend,
  roi,
  request,
  frame,
  labels,
  labelsLoading,
  labelsError,
  onClose,
  onLabelsChange,
  onSaved,
}: RoiAnnotationModalProps) {
  const initialSnapshotRef = useRef<EditorSnapshot>({
    classificationLabelId: null,
    mask: createEmptyMask(frame.width, frame.height),
  });
  const [historyState, setHistoryState] = useState<{
    history: EditorSnapshot[];
    index: number;
    previewMask: Uint8Array | null;
  }>({
    history: [cloneSnapshot(initialSnapshotRef.current)],
    index: 0,
    previewMask: null,
  });
  const [loadState, setLoadState] = useState<{
    loading: boolean;
    error: string | null;
  }>({
    loading: true,
    error: null,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [tool, setTool] = useState<"brush" | "erase">("brush");
  const [brushSize, setBrushSize] = useState(10);
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [activePaintLabelId, setActivePaintLabelId] = useState<string | null>(labels?.[0]?.id ?? null);
  const [labelDraft, setLabelDraft] = useState({
    name: "",
    id: "",
    color: "#22c55e",
  });
  const [labelSaveState, setLabelSaveState] = useState<{
    saving: boolean;
    error: string | null;
  }>({
    saving: false,
    error: null,
  });
  const [labelManagerOpen, setLabelManagerOpen] = useState(false);
  const [labelColorDrafts, setLabelColorDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoadState({ loading: true, error: null });
    setSaveError(null);

    void (async () => {
      try {
        const loaded = await backend.loadRoiFrameAnnotation(workspacePath, request);
        const initialMask = loaded.maskBase64Png
          ? await decodeMaskBase64Png(loaded.maskBase64Png, frame.width, frame.height)
          : createEmptyMask(frame.width, frame.height);
        const snapshot = {
          classificationLabelId: loaded.annotation.classificationLabelId ?? null,
          mask: initialMask,
        } satisfies EditorSnapshot;
        if (cancelled) return;
        initialSnapshotRef.current = cloneSnapshot(snapshot);
        setHistoryState({
          history: [cloneSnapshot(snapshot)],
          index: 0,
          previewMask: null,
        });
        setLoadState({ loading: false, error: null });
      } catch (error) {
        if (cancelled) return;
        initialSnapshotRef.current = {
          classificationLabelId: null,
          mask: createEmptyMask(frame.width, frame.height),
        };
        setHistoryState({
          history: [cloneSnapshot(initialSnapshotRef.current)],
          index: 0,
          previewMask: null,
        });
        setLoadState({ loading: false, error: toErrorMessage(error) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backend, frame.height, frame.width, request, workspacePath]);

  useEffect(() => {
    if (!labels || labels.length === 0) {
      setActivePaintLabelId(null);
      return;
    }
    if (!activePaintLabelId || !labels.some((label) => label.id === activePaintLabelId)) {
      setActivePaintLabelId(labels[0]?.id ?? null);
    }
  }, [activePaintLabelId, labels]);

  useEffect(() => {
    if (!labelManagerOpen) return;
    setLabelColorDrafts(
      Object.fromEntries((labels ?? []).map((label) => [label.id, label.color])),
    );
  }, [labelManagerOpen, labels]);

  const currentSnapshot = historyState.history[historyState.index] ?? initialSnapshotRef.current;
  const effectiveMask = historyState.previewMask ?? currentSnapshot.mask;
  const canEdit = !labelsLoading && !labelsError && (labels?.length ?? 0) > 0 && !loadState.error;
  const canManageLabels = !labelsLoading && !labelsError;
  const dirty = useMemo(
    () => !snapshotsEqual(currentSnapshot, initialSnapshotRef.current),
    [currentSnapshot],
  );
  const selectedClassificationLabel = labels?.find(
    (label) => label.id === currentSnapshot.classificationLabelId,
  );
  const labelColorsDirty = useMemo(
    () =>
      (labels ?? []).some((label) => (labelColorDrafts[label.id] ?? label.color) !== label.color),
    [labelColorDrafts, labels],
  );

  const commitSnapshot = useCallback((nextSnapshot: EditorSnapshot) => {
    setHistoryState((current) => {
      const active = current.history[current.index] ?? initialSnapshotRef.current;
      if (snapshotsEqual(active, nextSnapshot)) {
        return { ...current, previewMask: null };
      }
      const history = current.history
        .slice(0, current.index + 1)
        .map((snapshot) => cloneSnapshot(snapshot));
      history.push(cloneSnapshot(nextSnapshot));
      return {
        history,
        index: history.length - 1,
        previewMask: null,
      };
    });
  }, []);

  const requestClose = useCallback(() => {
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && labelManagerOpen) {
        event.preventDefault();
        setLabelManagerOpen(false);
        return;
      }
      const modifierPressed = event.metaKey || event.ctrlKey;
      if (modifierPressed && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setHistoryState((current) => {
          if (event.shiftKey) {
            if (current.index >= current.history.length - 1) return current;
            return { ...current, index: current.index + 1, previewMask: null };
          }
          if (current.index <= 0) return current;
          return { ...current, index: current.index - 1, previewMask: null };
        });
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [labelManagerOpen, requestClose]);

  const handleClassificationChange = useCallback(
    (labelId: string | null) => {
      commitSnapshot({
        classificationLabelId:
          currentSnapshot.classificationLabelId === labelId ? null : labelId,
        mask: currentSnapshot.mask.slice(),
      });
    },
    [commitSnapshot, currentSnapshot],
  );

  const handleClearMask = useCallback(() => {
    commitSnapshot({
      classificationLabelId: currentSnapshot.classificationLabelId,
      mask: createEmptyMask(frame.width, frame.height),
    });
  }, [commitSnapshot, currentSnapshot.classificationLabelId, frame.height, frame.width]);

  const handleSave = useCallback(async () => {
    if (!canEdit || saving || loadState.loading) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        classificationLabelId: currentSnapshot.classificationLabelId,
        maskBase64Png: maskHasPixels(currentSnapshot.mask)
          ? await encodeMaskToBase64Png(currentSnapshot.mask, frame.width, frame.height)
          : null,
      };
      const saved = await backend.saveRoiFrameAnnotation(workspacePath, request, payload);
      initialSnapshotRef.current = cloneSnapshot(currentSnapshot);
      setHistoryState({
        history: [cloneSnapshot(currentSnapshot)],
        index: 0,
        previewMask: null,
      });
      setSaving(false);
      onSaved(saved);
    } catch (error) {
      setSaving(false);
      setSaveError(toErrorMessage(error));
    }
  }, [
    backend,
    canEdit,
    currentSnapshot,
    frame.height,
    frame.width,
    loadState.loading,
    onSaved,
    request,
    saving,
    workspacePath,
  ]);

  const handleAddLabel = useCallback(async () => {
    if (!canManageLabels || labelSaveState.saving) return;
    const name = labelDraft.name.trim();
    const id = (labelDraft.id.trim() || slugifyLabelId(name)).trim();
    if (!name) {
      setLabelSaveState({
        saving: false,
        error: "Label name is required.",
      });
      return;
    }
    if (!id) {
      setLabelSaveState({
        saving: false,
        error: "Label id is required.",
      });
      return;
    }
    if ((labels ?? []).some((label) => label.id === id)) {
      setLabelSaveState({
        saving: false,
        error: `A label with id '${id}' already exists.`,
      });
      return;
    }

    setLabelSaveState({ saving: true, error: null });
    try {
      const nextLabels = [
        ...(labels ?? []),
        {
          id,
          name,
          color: labelDraft.color,
        },
      ];
      const savedLabels = await backend.saveAnnotationLabels(workspacePath, nextLabels);
      onLabelsChange(savedLabels);
      setActivePaintLabelId((current) => current ?? savedLabels[0]?.id ?? null);
      setLabelColorDrafts(Object.fromEntries(savedLabels.map((label) => [label.id, label.color])));
      setLabelDraft({
        name: "",
        id: "",
        color: "#22c55e",
      });
      setLabelSaveState({ saving: false, error: null });
    } catch (error) {
      setLabelSaveState({
        saving: false,
        error: toErrorMessage(error),
      });
    }
  }, [backend, canManageLabels, labelDraft.color, labelDraft.id, labelDraft.name, labelSaveState.saving, labels, onLabelsChange, workspacePath]);

  const openLabelManager = useCallback(() => {
    setLabelSaveState({ saving: false, error: null });
    setLabelManagerOpen(true);
  }, []);

  const closeLabelManager = useCallback(() => {
    if (labelSaveState.saving) return;
    setLabelManagerOpen(false);
  }, [labelSaveState.saving]);

  const handleSaveLabelColors = useCallback(async () => {
    if (!canManageLabels || labelSaveState.saving || !labelColorsDirty) return;
    setLabelSaveState({ saving: true, error: null });
    try {
      const nextLabels = (labels ?? []).map((label) => ({
        ...label,
        color: labelColorDrafts[label.id] ?? label.color,
      }));
      const savedLabels = await backend.saveAnnotationLabels(workspacePath, nextLabels);
      onLabelsChange(savedLabels);
      setLabelColorDrafts(Object.fromEntries(savedLabels.map((label) => [label.id, label.color])));
      setLabelSaveState({ saving: false, error: null });
    } catch (error) {
      setLabelSaveState({
        saving: false,
        error: toErrorMessage(error),
      });
    }
  }, [
    backend,
    canManageLabels,
    labelColorDrafts,
    labelColorsDirty,
    labelSaveState.saving,
    labels,
    onLabelsChange,
    workspacePath,
  ]);

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            requestClose();
          }
        }}
      >
        <div
          className="flex h-full max-h-[min(92vh,56rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[1.75rem] border border-border/80 bg-card shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="roi-annotation-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-5">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="roi-annotation-title" className="text-lg font-medium text-foreground">
                  ROI {roi.roi} Annotation
                </h2>
                {dirty ? (
                  <span className="rounded-full border border-amber-400/35 bg-amber-400/10 px-2.5 py-1 text-xs font-medium text-amber-200">
                    Unsaved
                  </span>
                ) : null}
                {selectedClassificationLabel ? (
                  <span
                    className="rounded-full border px-2.5 py-1 text-xs font-medium"
                    style={colorStyle(selectedClassificationLabel.color, true)}
                  >
                    {selectedClassificationLabel.name}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">
                Pos{request.pos} | C{request.channel} | T{request.time} | Z{request.z} | {frame.width} x {frame.height}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <div className="flex min-w-[16rem] max-w-[28rem] flex-wrap items-center justify-end gap-2 rounded-2xl border border-border bg-background/45 px-3 py-2">
                <span className="text-xs font-medium text-foreground">Label Set</span>
                {(labels?.length ?? 0) > 0 ? (
                  <>
                    <div className="flex flex-wrap justify-end gap-2">
                      {(labels ?? []).map((label) => (
                        <span
                          key={label.id}
                          className="rounded-full border px-2.5 py-1 text-xs font-medium"
                          style={colorStyle(label.color, false)}
                        >
                          {label.name}
                        </span>
                      ))}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {(labels?.length ?? 0)} label{(labels?.length ?? 0) === 1 ? "" : "s"}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No labels yet
                  </span>
                )}
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Manage annotation labels"
                  disabled={!canManageLabels}
                  onClick={openLabelManager}
                >
                  <Settings className="size-4" />
                </button>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-9 px-3 text-xs"
                onClick={requestClose}
              >
                Close
              </Button>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="min-h-0 border-b border-border p-5 lg:border-b-0 lg:border-r">
              <RoiAnnotationCanvas
                frame={frame}
                labels={labels ?? []}
                mask={effectiveMask}
                activeLabelId={activePaintLabelId}
                tool={tool}
                brushSize={brushSize}
                overlayOpacity={overlayOpacity}
                disabled={!canEdit || loadState.loading}
                className="h-full min-h-[28rem] w-full"
                onStrokeStart={() => setSaveError(null)}
                onPreviewMaskChange={(nextMask) =>
                  setHistoryState((current) => ({ ...current, previewMask: nextMask.slice() }))
                }
                onStrokeCommit={(nextMask) =>
                  commitSnapshot({
                    classificationLabelId: currentSnapshot.classificationLabelId,
                    mask: nextMask.slice(),
                  })
                }
              />
            </div>

            <aside className="min-h-0 overflow-y-auto px-5 py-5">
              <div className="space-y-5">
                {loadState.loading ? (
                  <div className="rounded-2xl border border-border bg-background/50 px-4 py-3 text-sm text-muted-foreground">
                    Loading annotation...
                  </div>
                ) : null}
                {loadState.error ? (
                  <div className="rounded-2xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    {loadState.error}
                  </div>
                ) : null}
                {labelsLoading ? (
                  <div className="rounded-2xl border border-border bg-background/50 px-4 py-3 text-sm text-muted-foreground">
                    Loading annotation labels...
                  </div>
                ) : null}
                {labelsError ? (
                  <div className="rounded-2xl border border-amber-400/35 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                    {labelsError}
                  </div>
                ) : null}
                {!labelsLoading && !labelsError && (labels?.length ?? 0) === 0 ? (
                  <div className="rounded-2xl border border-amber-400/35 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                    No annotation labels were found for this workspace.
                  </div>
                ) : null}
                {saveError ? (
                  <div className="rounded-2xl border border-red-500/35 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    {saveError}
                  </div>
                ) : null}

                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-foreground">Classification</h3>
                    <span className="text-xs text-muted-foreground">
                      {currentSnapshot.classificationLabelId ? "1 selected" : "Optional"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(labels ?? []).map((label) => {
                      const active = currentSnapshot.classificationLabelId === label.id;
                      return (
                        <button
                          key={label.id}
                          type="button"
                          className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                          style={colorStyle(label.color, active)}
                          disabled={!canEdit || loadState.loading}
                          onClick={() => handleClassificationChange(label.id)}
                        >
                          {label.name}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!canEdit || loadState.loading}
                      onClick={() => handleClassificationChange(null)}
                    >
                      Clear
                    </button>
                  </div>
                </section>

                <section className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-foreground">Segmentation</h3>
                    <span className="text-xs text-muted-foreground">
                      {maskHasPixels(effectiveMask) ? "Mask present" : "No mask"}
                    </span>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Paint label</p>
                    <div className="flex flex-wrap gap-2">
                      {(labels ?? []).map((label) => {
                        const active = activePaintLabelId === label.id;
                        return (
                          <button
                            key={label.id}
                            type="button"
                            className="rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                            style={colorStyle(label.color, active)}
                            disabled={!canEdit || loadState.loading}
                            onClick={() => setActivePaintLabelId(label.id)}
                          >
                            {label.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      variant={tool === "brush" ? "default" : "outline"}
                      className="h-9 text-xs"
                      disabled={!canEdit || loadState.loading}
                      onClick={() => setTool("brush")}
                    >
                      Brush
                    </Button>
                    <Button
                      size="sm"
                      variant={tool === "erase" ? "default" : "outline"}
                      className="h-9 text-xs"
                      disabled={!canEdit || loadState.loading}
                      onClick={() => setTool("erase")}
                    >
                      Erase
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-medium text-muted-foreground">Brush size</p>
                      <span className="text-xs text-muted-foreground">{brushSize}px</span>
                    </div>
                    <Slider
                      value={brushSize}
                      min={1}
                      max={64}
                      step={1}
                      disabled={!canEdit || loadState.loading}
                      onValueChange={(value) => setBrushSize(Math.round(value))}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-medium text-muted-foreground">Overlay opacity</p>
                      <span className="text-xs text-muted-foreground">{overlayOpacity.toFixed(2)}</span>
                    </div>
                    <Slider
                      value={overlayOpacity}
                      min={0.05}
                      max={0.95}
                      step={0.01}
                      onValueChange={(value) => setOverlayOpacity(value)}
                    />
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 w-full text-xs"
                    disabled={!canEdit || loadState.loading || !maskHasPixels(effectiveMask)}
                    onClick={handleClearMask}
                  >
                    Clear mask
                  </Button>
                </section>

                <section className="space-y-2 rounded-2xl border border-border bg-background/45 px-4 py-3">
                  <h3 className="text-sm font-medium text-foreground">Shortcuts</h3>
                  <p className="text-xs text-muted-foreground">Paint on the frame with the active tool. Undo with Ctrl/Cmd+Z and redo with Ctrl/Cmd+Shift+Z.</p>
                </section>
              </div>
            </aside>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
            <p className="text-xs text-muted-foreground">
              {canEdit
                ? "Changes are stored only when you save."
                : "Saving is disabled until the workspace label set is available."}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-9 px-4 text-xs"
                onClick={requestClose}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-9 px-4 text-xs"
                disabled={!canEdit || loadState.loading || saving || !dirty}
                onClick={() => void handleSave()}
              >
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {labelManagerOpen ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 px-4 py-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeLabelManager();
            }
          }}
        >
          <div
            className="w-full max-w-lg rounded-[1.5rem] border border-border/80 bg-card shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="annotation-label-settings-title"
          >
            <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
              <div className="space-y-1">
                <h2
                  id="annotation-label-settings-title"
                  className="text-base font-medium text-foreground"
                >
                  Annotation Label Settings
                </h2>
                <p className="text-sm text-muted-foreground">
                  Add labels and tune their colors for classification chips and semantic mask painting.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-9 px-3 text-xs"
                disabled={labelSaveState.saving}
                onClick={closeLabelManager}
              >
                Close
              </Button>
            </div>

            <div className="space-y-5 px-5 py-5">
              {(labels?.length ?? 0) > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Current labels
                  </p>
                  <div className="space-y-2">
                    {(labels ?? []).map((label) => (
                      <div
                        key={label.id}
                        className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-background/45 px-3 py-2"
                      >
                        <div className="min-w-0 space-y-1">
                          <span
                            className="inline-flex rounded-full border px-2.5 py-1 text-xs font-medium"
                            style={colorStyle(labelColorDrafts[label.id] ?? label.color, false)}
                          >
                            {label.name}
                          </span>
                          <p className="text-xs text-muted-foreground">{label.id}</p>
                        </div>
                        <Input
                          nativeInput
                          type="color"
                          size="sm"
                          className="h-9 w-14 shrink-0 overflow-hidden px-1.5"
                          value={labelColorDrafts[label.id] ?? label.color}
                          onChange={(event) =>
                            setLabelColorDrafts((current) => ({
                              ...current,
                              [label.id]: event.target.value,
                            }))
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-9 px-3 text-xs"
                      disabled={!canManageLabels || labelSaveState.saving || !labelColorsDirty}
                      onClick={() => void handleSaveLabelColors()}
                    >
                      {labelSaveState.saving && labelColorsDirty ? "Saving colors..." : "Save colors"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-border bg-background/45 px-4 py-3 text-sm text-muted-foreground">
                  No labels yet. Add one below to enable annotation for this workspace.
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Label name</p>
                  <Input
                    size="sm"
                    value={labelDraft.name}
                    placeholder="Cell"
                    onChange={(event) => {
                      const name = event.target.value;
                      setLabelDraft((current) => ({
                        ...current,
                        name,
                        id: current.id.length > 0 ? current.id : slugifyLabelId(name),
                      }));
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Color</p>
                  <Input
                    nativeInput
                    type="color"
                    size="sm"
                    className="h-9 overflow-hidden px-1.5"
                    value={labelDraft.color}
                    onChange={(event) =>
                      setLabelDraft((current) => ({ ...current, color: event.target.value }))
                    }
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Label id</p>
                <Input
                  size="sm"
                  value={labelDraft.id}
                  placeholder="cell"
                  onChange={(event) =>
                    setLabelDraft((current) => ({ ...current, id: event.target.value }))
                  }
                />
              </div>

              {labelSaveState.error ? (
                <div className="rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                  {labelSaveState.error}
                </div>
              ) : null}

              <div className="flex justify-end gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 px-3 text-xs"
                  disabled={labelSaveState.saving}
                  onClick={closeLabelManager}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-9 px-3 text-xs"
                  disabled={!canManageLabels || labelSaveState.saving}
                  onClick={() => void handleAddLabel()}
                >
                  {labelSaveState.saving ? "Adding label..." : "Add label"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {discardConfirmOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4">
          <div
            className="w-full max-w-md rounded-2xl border border-border/80 bg-card p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="annotation-discard-title"
          >
            <div className="space-y-4">
              <div className="space-y-1">
                <h2 id="annotation-discard-title" className="text-base font-medium text-foreground">
                  Discard annotation changes?
                </h2>
                <p className="text-sm text-muted-foreground">
                  This frame has unsaved classification or segmentation edits.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={() => setDiscardConfirmOpen(false)}
                >
                  Keep editing
                </Button>
                <Button
                  size="sm"
                  className="h-8 px-3 text-xs"
                  onClick={() => {
                    setDiscardConfirmOpen(false);
                    onClose();
                  }}
                >
                  Discard
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
