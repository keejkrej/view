import type {
  ContrastWindow,
  FrameRequest,
  GridState,
  ViewerSource,
  ViewerCanvasStatusMessage,
} from "@view/view";

declare global {
  interface Window {
    QWebChannel?: new (
      transport: unknown,
      callback: (channel: {
        objects?: {
          viewBridge?: {
            postMessage: (message: string) => void;
          };
        };
      }) => void,
    ) => void;
    __viewPyApplyState?: (next: unknown) => void;
    qt?: {
      webChannelTransport?: unknown;
    };
  }
}

interface HostContrastState {
  mode?: "auto" | "manual";
  value?: ContrastWindow | null;
}

export interface HostCanvasState {
  backendUrl?: string;
  source?: ViewerSource | null;
  request?: FrameRequest | null;
  contrast?: HostContrastState;
  grid?: Partial<GridState>;
  excludedCellIds?: string[];
  selectionMode?: boolean;
  emptyText?: string;
  messages?: ViewerCanvasStatusMessage[];
}

interface FrameLoadedPayload {
  width: number;
  height: number;
  contrastDomain?: ContrastWindow;
  suggestedContrast?: ContrastWindow;
  appliedContrast?: ContrastWindow;
}

let messageId = 0;
let bridgePromise: Promise<{ postMessage: (message: string) => void } | null> | null = null;

function loadWebChannelScript() {
  if (window.QWebChannel) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "qrc:///qtwebchannel/qwebchannel.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load qwebchannel.js"));
    document.head.appendChild(script);
  });
}

async function resolveBridge() {
  if (bridgePromise) {
    return bridgePromise;
  }

  bridgePromise = (async () => {
    const transport = window.qt?.webChannelTransport;
    if (!transport) {
      return null;
    }
    await loadWebChannelScript();
    return await new Promise<{ postMessage: (message: string) => void } | null>((resolve) => {
      if (!window.QWebChannel) {
        resolve(null);
        return;
      }
      new window.QWebChannel(transport, (channel) => {
        resolve(channel.objects?.viewBridge ?? null);
      });
    });
  })();

  return bridgePromise;
}

function emitHostEvent(type: string, payload: unknown) {
  messageId += 1;
  const envelope = JSON.stringify({ id: messageId, type, payload });
  void resolveBridge()
    .then((bridge) => {
      if (bridge) {
        bridge.postMessage(envelope);
        return;
      }
      document.title = `__viewpy__${envelope}`;
    })
    .catch(() => {
      document.title = `__viewpy__${envelope}`;
    });
}

export function installHostStateListener(onState: (next: HostCanvasState) => void) {
  window.__viewPyApplyState = (next) => {
    if (!next || typeof next !== "object") return;
    onState(next as HostCanvasState);
  };
  emitHostEvent("ready", null);

  return () => {
    delete window.__viewPyApplyState;
  };
}

export function sendGridChanged(grid: GridState) {
  emitHostEvent("gridChanged", grid);
}

export function sendExcludedCellsToggled(cellIds: string[]) {
  emitHostEvent("excludedCellsToggled", cellIds);
}

export function sendFrameLoaded(payload: FrameLoadedPayload) {
  emitHostEvent("frameLoaded", payload);
}

export function sendFrameLoadFailed(message: string) {
  emitHostEvent("frameLoadFailed", { message });
}
