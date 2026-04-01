import { Effect } from "effect";

import type {
  CropOutputFormat,
  CropRoiResponse,
  FrameRequest,
  FrameResult,
  LoadFrameOptions,
  SaveBboxResponse,
  ViewerBackend,
  ViewerSource,
  WorkspaceScan,
} from "./viewerTypes";

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

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" && error.length > 0 ? error : fallback);
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

class WebSocketBackend implements ViewerBackend {
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

  async scanSource(source: ViewerSource): Promise<WorkspaceScan> {
    return Effect.runPromise(this.requestEffect<WorkspaceScan>("scan_source", { source }));
  }

  async loadFrame(
    source: ViewerSource,
    request: FrameRequest,
    options?: LoadFrameOptions,
  ): Promise<FrameResult> {
    const payload = await Effect.runPromise(
      this.requestEffect<FramePayload>("load_frame", {
        source,
        request,
        contrast: options?.contrast ?? null,
      }),
    );
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

  async saveBbox(
    workspacePath: string,
    source: ViewerSource,
    pos: number,
    csv: string,
  ): Promise<SaveBboxResponse> {
    return Effect.runPromise(
      this.requestEffect<SaveBboxResponse>("save_bbox", { workspacePath, source, pos, csv }),
    );
  }

  async cropRoi(
    workspacePath: string,
    source: ViewerSource,
    pos: number,
    format: CropOutputFormat,
  ): Promise<CropRoiResponse> {
    return Effect.runPromise(
      this.requestEffect<CropRoiResponse>("crop_roi", { workspacePath, source, pos, format }),
    );
  }

  private requestEffect<T>(type: string, payload: unknown) {
    return Effect.tryPromise({
      try: async (signal: AbortSignal) => {
        const socket = await this.ensureSocket();
        const id = `${Date.now()}-${this.nextId++}`;
        const body: RequestEnvelope = { id, type, payload };

        return await new Promise<T>((resolve, reject) => {
          const cleanup = () => {
            signal.removeEventListener("abort", onAbort);
            this.pending.delete(id);
          };

          const onAbort = () => {
            cleanup();
            reject(new DOMException(`Request ${type} aborted`, "AbortError"));
          };

          signal.addEventListener("abort", onAbort, { once: true });
          this.pending.set(id, {
            resolve: (value) => {
              cleanup();
              resolve(value as T);
            },
            reject: (error) => {
              cleanup();
              reject(error);
            },
          });

          try {
            socket.send(JSON.stringify(body));
          } catch (error) {
            cleanup();
            reject(toError(error, `Failed to send ${type} request`));
          }
        });
      },
      catch: (error: unknown) => toError(error, `Request ${type} failed`),
    }).pipe(Effect.withSpan(`viewer.ws.${type}`));
  }

  private ensureSocket(): Promise<WebSocket> {
    if (!this.socketPromise) {
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
    }

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

export function createWebSocketBackend(options: WebSocketBackendOptions): ViewerBackend {
  return new WebSocketBackend(options);
}
