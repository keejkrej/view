import type {
  FrameRequest,
  FrameResult,
  LoadFrameOptions,
  PosViewerBackend,
  SaveBboxResponse,
  WorkspaceScan,
} from "./types";

interface RequestEnvelope {
  id: string;
  type: string;
  payload: unknown;
}

interface ResponseEnvelope {
  id?: string;
  type: string;
  payload?: unknown;
}

interface ErrorPayload {
  message: string;
}

interface FramePayload {
  width: number;
  height: number;
  dataBase64: string;
  pixelType?: FrameResult["pixelType"];
  contrastDomain?: FrameResult["contrastDomain"];
  suggestedContrast?: FrameResult["suggestedContrast"];
  appliedContrast?: FrameResult["appliedContrast"];
}

interface WebSocketBackendOptions {
  url: string;
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

class WebSocketBackend implements PosViewerBackend {
  private readonly url: string;

  private socketPromise: Promise<WebSocket> | null = null;

  private nextId = 0;

  private readonly pending = new Map<
    string,
    {
      resolve: (payload: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(options: WebSocketBackendOptions) {
    this.url = options.url;
  }

  async scanWorkspace(root: string): Promise<WorkspaceScan> {
    return this.request<WorkspaceScan>("scan_workspace", { root });
  }

  async loadFrame(
    root: string,
    request: FrameRequest,
    options?: LoadFrameOptions,
  ): Promise<FrameResult> {
    const payload = await this.request<FramePayload>("load_frame", {
      root,
      request,
      contrast: options?.contrast ?? null,
    });
    return {
      width: payload.width,
      height: payload.height,
      pixels: decodeBase64ToBytes(payload.dataBase64),
      pixelType: payload.pixelType ?? "uint8",
      contrastDomain: payload.contrastDomain,
      suggestedContrast: payload.suggestedContrast,
      appliedContrast: payload.appliedContrast,
    };
  }

  async saveBbox(root: string, pos: number, csv: string): Promise<SaveBboxResponse> {
    return this.request<SaveBboxResponse>("save_bbox", { root, pos, csv });
  }

  private async request<T>(type: string, payload: unknown): Promise<T> {
    const socket = await this.ensureSocket();
    const id = `${Date.now()}-${this.nextId++}`;
    const body: RequestEnvelope = { id, type, payload };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      socket.send(JSON.stringify(body));
    });
  }

  private async ensureSocket(): Promise<WebSocket> {
    if (this.socketPromise) {
      return this.socketPromise;
    }

    this.socketPromise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url);
      socket.addEventListener("open", () => resolve(socket), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`Failed to connect to ${this.url}`)),
        { once: true },
      );
      socket.addEventListener("message", (event) => this.handleMessage(event));
      socket.addEventListener("close", () => {
        this.socketPromise = null;
        const error = new Error(`WebSocket connection to ${this.url} closed`);
        for (const { reject: pendingReject } of this.pending.values()) {
          pendingReject(error);
        }
        this.pending.clear();
      });
    });

    return this.socketPromise;
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;

    let envelope: ResponseEnvelope;
    try {
      envelope = JSON.parse(event.data) as ResponseEnvelope;
    } catch {
      return;
    }

    if (!envelope.id) return;
    const pending = this.pending.get(envelope.id);
    if (!pending) return;
    this.pending.delete(envelope.id);

    if (envelope.type === "error") {
      const payload = (envelope.payload ?? {}) as Partial<ErrorPayload>;
      pending.reject(new Error(payload.message ?? "Unknown backend error"));
      return;
    }

    pending.resolve(envelope.payload);
  }
}

export function createWebSocketBackend(options: WebSocketBackendOptions): PosViewerBackend {
  return new WebSocketBackend(options);
}
