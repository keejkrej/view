import {
  ViewerCanvasSurface,
  createDefaultGrid,
  createWebSocketBackend,
  makeFrameKey,
  normalizeGridState,
  toggleCellIds,
  type ContrastWindow,
  type FrameRequest,
  type FrameResult,
  type GridState,
  type ViewerBackend,
  type ViewerCanvasStatusMessage,
  type ViewerSource,
} from "@view/view";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  installHostStateListener,
  sendExcludedCellsToggled,
  sendFrameLoaded,
  sendFrameLoadFailed,
  sendGridChanged,
  type HostCanvasState,
} from "./host";

type ContrastMode = "auto" | "manual";

interface SurfaceState {
  backendUrl: string | null;
  source: ViewerSource | null;
  request: FrameRequest | null;
  contrastMode: ContrastMode;
  contrast: ContrastWindow | null;
  grid: GridState;
  excludedCellIds: string[];
  selectionMode: boolean;
  emptyText: string;
  messages: ViewerCanvasStatusMessage[];
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

  set(key: string, value: CachedFrame) {
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

function normalizeMessages(messages: HostCanvasState["messages"]): ViewerCanvasStatusMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    if (typeof message.text !== "string" || !message.text) return [];
    return [
      {
        text: message.text,
        tone:
          message.tone === "error" || message.tone === "success" || message.tone === "default"
            ? message.tone
            : "default",
      },
    ];
  });
}

function normalizeHostState(next: HostCanvasState): SurfaceState {
  const request = next.request;
  const contrast = next.contrast;
  const contrastMode: ContrastMode = contrast?.mode === "manual" ? "manual" : "auto";
  return {
    backendUrl: typeof next.backendUrl === "string" && next.backendUrl ? next.backendUrl : null,
    source:
      next.source &&
      typeof next.source === "object" &&
      (next.source.kind === "workspace" || next.source.kind === "nd2") &&
      typeof next.source.path === "string" &&
      next.source.path
        ? { kind: next.source.kind, path: next.source.path }
        : null,
    request:
      request &&
      typeof request === "object" &&
      typeof request.pos === "number" &&
      typeof request.channel === "number" &&
      typeof request.time === "number" &&
      typeof request.z === "number"
        ? request
        : null,
    contrastMode,
    contrast:
      contrastMode === "manual" &&
      contrast?.value &&
      typeof contrast.value.min === "number" &&
      typeof contrast.value.max === "number"
        ? { min: contrast.value.min, max: contrast.value.max }
        : null,
    grid: normalizeGridState(next.grid ?? createDefaultGrid()),
    excludedCellIds: Array.isArray(next.excludedCellIds)
      ? next.excludedCellIds.filter((cellId): cellId is string => typeof cellId === "string")
      : [],
    selectionMode: next.selectionMode === true,
    emptyText:
      typeof next.emptyText === "string" ? next.emptyText : "Open a workspace or ND2 file to load frames",
    messages: normalizeMessages(next.messages),
  };
}

function loadKeyForState(state: SurfaceState): string | null {
  if (!state.source || !state.request) return null;
  const contrastKey =
    state.contrastMode === "manual" && state.contrast
      ? `${state.contrast.min}:${state.contrast.max}`
      : "auto";
  return `${makeFrameKey(state.source, state.request)}:${contrastKey}`;
}

function notifyFrameLoaded(frame: FrameResult) {
  sendFrameLoaded({
    width: frame.width,
    height: frame.height,
    contrastDomain: frame.contrastDomain,
    suggestedContrast: frame.suggestedContrast,
    appliedContrast: frame.appliedContrast,
  });
}

export default function App() {
  const frameCacheRef = useRef(new FrameCache());
  const [surfaceState, setSurfaceState] = useState<SurfaceState>(() =>
    normalizeHostState({
      source: null,
      request: null,
      contrast: { mode: "auto", value: null },
      grid: createDefaultGrid(),
      excludedCellIds: [],
      selectionMode: false,
      emptyText: "Open a workspace or ND2 file to load frames",
      messages: [],
    }),
  );
  const [frame, setFrame] = useState<FrameResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => installHostStateListener((next) => setSurfaceState(normalizeHostState(next))), []);

  const backend = useMemo<ViewerBackend | null>(() => {
    if (!surfaceState.backendUrl) return null;
    return createWebSocketBackend({ url: surfaceState.backendUrl });
  }, [surfaceState.backendUrl]);

  const requestKey = useMemo(() => loadKeyForState(surfaceState), [surfaceState]);
  const requestSource = surfaceState.source;
  const requestSelection = surfaceState.request;
  const requestContrast =
    surfaceState.contrastMode === "manual" && surfaceState.contrast ? surfaceState.contrast : undefined;

  useEffect(() => {
    if (!backend || !requestSource || !requestSelection || !requestKey) {
      setFrame(null);
      setLoading(false);
      setLoadError(null);
      return;
    }

    const cached = frameCacheRef.current.get(requestKey);
    if (cached) {
      setFrame(cached.frame);
      setLoading(false);
      setLoadError(null);
      notifyFrameLoaded(cached.frame);
      return;
    }

    let cancelled = false;
    setFrame(null);
    setLoading(true);
    setLoadError(null);

    void (async () => {
      try {
        const loaded = await backend.loadFrame(
          requestSource,
          requestSelection,
          requestContrast ? { contrast: requestContrast } : undefined,
        );
        if (cancelled) return;
        frameCacheRef.current.set(requestKey, { frame: loaded });
        setFrame(loaded);
        notifyFrameLoaded(loaded);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setFrame(null);
        setLoadError(message);
        sendFrameLoadFailed(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backend, requestContrast, requestKey, requestSelection, requestSource]);

  const messages = useMemo(() => {
    if (!loadError) return surfaceState.messages;
    if (surfaceState.messages.some((message) => message.tone === "error" && message.text === loadError)) {
      return surfaceState.messages;
    }
    return [...surfaceState.messages, { tone: "error" as const, text: loadError }];
  }, [loadError, surfaceState.messages]);

  return (
    <div style={{ height: "100%", width: "100%", overflow: "hidden" }}>
      <ViewerCanvasSurface
        frame={frame}
        grid={surfaceState.grid}
        excludedCellIds={surfaceState.excludedCellIds}
        selectionMode={surfaceState.selectionMode}
        loading={loading}
        emptyText={surfaceState.emptyText}
        messages={messages}
        onGridChange={(nextGrid) => {
          setSurfaceState((current) => ({ ...current, grid: nextGrid }));
          sendGridChanged(nextGrid);
        }}
        onToggleCells={(cellIds) => {
          if (cellIds.length === 0) return;
          setSurfaceState((current) => ({
            ...current,
            excludedCellIds: toggleCellIds(current.excludedCellIds, cellIds),
          }));
          sendExcludedCellsToggled(cellIds);
        }}
      />
    </div>
  );
}
