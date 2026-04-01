import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createWebSocketBackend } from "../src/ws";

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static instance: FakeWebSocket | null = null;

  private readonly listeners = new Map<string, Listener[]>();

  readonly sent: string[] = [];

  constructor(_url: string) {
    FakeWebSocket.instance = this;
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string) {
    this.sent.push(message);
  }

  emit(type: string, event: { data?: string }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instance = null;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

describe("websocket backend", () => {
  test("resolves scan requests from websocket responses", async () => {
    const backend = createWebSocketBackend({ url: "ws://example.test" });
    const promise = backend.scanSource({ kind: "tif", path: "/tmp/workspace" });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as { id: string; type: string };

    expect(sent.type).toBe("scan_source");

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "scan_source_result",
        payload: {
          positions: [1],
          channels: [2],
          times: [3],
          zSlices: [4],
        },
      }),
    });

    await expect(promise).resolves.toEqual({
      positions: [1],
      channels: [2],
      times: [3],
      zSlices: [4],
    });
  });

  test("rejects backend error payloads", async () => {
    const backend = createWebSocketBackend({ url: "ws://example.test" });
    const promise = backend.saveBbox(
      "/tmp/workspace",
      { kind: "tif", path: "/tmp/workspace/images" },
      7,
      "roi,x,y,w,h",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as { id: string };

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "error",
        payload: {
          message: "save failed",
        },
      }),
    });

    await expect(promise).rejects.toThrow("save failed");
  });

  test("sends crop requests with the selected output format", async () => {
    const backend = createWebSocketBackend({ url: "ws://example.test" });
    const promise = backend.cropRoi(
      "/tmp/workspace",
      { kind: "tif", path: "/tmp/workspace/images" },
      3,
      "tiff",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as {
      id: string;
      type: string;
      payload: { workspacePath: string; pos: number; format: string };
    };

    expect(sent.type).toBe("crop_roi");
    expect(sent.payload.workspacePath).toBe("/tmp/workspace");
    expect(sent.payload.pos).toBe(3);
    expect(sent.payload.format).toBe("tiff");

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "crop_roi_result",
        payload: {
          ok: true,
          outputPath: "/tmp/workspace/roi/Pos3",
        },
      }),
    });

    await expect(promise).resolves.toEqual({
      ok: true,
      outputPath: "/tmp/workspace/roi/Pos3",
    });
  });

  test("delivers crop progress events without resolving the request early", async () => {
    const backend = createWebSocketBackend({ url: "ws://example.test" });
    const progressEvents: Array<{ requestId: string; progress: number; message: string }> = [];
    const unsubscribe = backend.onCropRoiProgress((event) => {
      progressEvents.push(event);
    });

    const promise = backend.cropRoi(
      "/tmp/workspace",
      { kind: "tif", path: "/tmp/workspace/images" },
      4,
      "tiff",
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as { id: string };

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "crop_roi_progress",
        payload: {
          progress: 0.5,
          message: "Cropping frame 5/10 for Pos4",
        },
      }),
    });

    expect(progressEvents).toEqual([
      {
        requestId: sent.id,
        progress: 0.5,
        message: "Cropping frame 5/10 for Pos4",
      },
    ]);

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "crop_roi_result",
        payload: {
          ok: true,
          outputPath: "/tmp/workspace/roi/Pos4",
        },
      }),
    });

    await expect(promise).resolves.toEqual({
      ok: true,
      outputPath: "/tmp/workspace/roi/Pos4",
    });

    unsubscribe();
  });
});
