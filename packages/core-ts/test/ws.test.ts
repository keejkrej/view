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

  test("requests ROI workspace scans", async () => {
    const backend = createWebSocketBackend({ url: "ws://example.test" });
    const promise = backend.scanRoiWorkspace("/tmp/workspace");

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as {
      id: string;
      type: string;
      payload: { workspacePath: string };
    };

    expect(sent.type).toBe("scan_roi_workspace");
    expect(sent.payload.workspacePath).toBe("/tmp/workspace");

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "scan_roi_workspace_result",
        payload: {
          positions: [
            {
              pos: 0,
              source: { kind: "nd2", path: "/tmp/source.nd2" },
              channels: [0, 1],
              times: [0, 1, 2],
              zSlices: [0],
              rois: [
                {
                  roi: 7,
                  fileName: "Roi7.tif",
                  bbox: { roi: 7, x: 1, y: 2, w: 3, h: 4 },
                  shape: [3, 2, 1, 4, 3],
                },
              ],
            },
          ],
        },
      }),
    });

    await expect(promise).resolves.toEqual({
      positions: [
        {
          pos: 0,
          source: { kind: "nd2", path: "/tmp/source.nd2" },
          channels: [0, 1],
          times: [0, 1, 2],
          zSlices: [0],
          rois: [
            {
              roi: 7,
              fileName: "Roi7.tif",
              bbox: { roi: 7, x: 1, y: 2, w: 3, h: 4 },
              shape: [3, 2, 1, 4, 3],
            },
          ],
        },
      ],
    });
  });

  test("loads ROI frames through the websocket backend", async () => {
    const backend = createWebSocketBackend({ url: "ws://example.test" });
    const promise = backend.loadRoiFrame("/tmp/workspace", {
      pos: 2,
      roi: 9,
      channel: 1,
      time: 4,
      z: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as {
      id: string;
      type: string;
      payload: {
        workspacePath: string;
        request: { pos: number; roi: number; channel: number; time: number; z: number };
      };
    };

    expect(sent.type).toBe("load_roi_frame");
    expect(sent.payload.workspacePath).toBe("/tmp/workspace");
    expect(sent.payload.request).toEqual({
      pos: 2,
      roi: 9,
      channel: 1,
      time: 4,
      z: 0,
    });

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "load_roi_frame_result",
        payload: {
          width: 2,
          height: 2,
          dataBase64: "AAECAw==",
          pixelType: "uint8",
          contrastDomain: { min: 0, max: 255 },
          suggestedContrast: { min: 1, max: 200 },
          appliedContrast: { min: 2, max: 180 },
        },
      }),
    });

    await expect(promise).resolves.toEqual({
      width: 2,
      height: 2,
      pixels: new Uint8Array([0, 1, 2, 3]),
      pixelType: "uint8",
      contrastDomain: { min: 0, max: 255 },
      suggestedContrast: { min: 1, max: 200 },
      appliedContrast: { min: 2, max: 180 },
    });
  });

  test("loads annotation labels through the websocket backend", async () => {
    const backend = createWebSocketBackend({ url: "ws://example.test" });
    const promise = backend.loadAnnotationLabels("/tmp/workspace");

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as {
      id: string;
      type: string;
      payload: { workspacePath: string };
    };

    expect(sent.type).toBe("load_annotation_labels");
    expect(sent.payload.workspacePath).toBe("/tmp/workspace");

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "load_annotation_labels_result",
        payload: [
          { id: "cell", name: "Cell", color: "#22c55e" },
          { id: "debris", name: "Debris", color: "#f97316" },
        ],
      }),
    });

    await expect(promise).resolves.toEqual([
      { id: "cell", name: "Cell", color: "#22c55e" },
      { id: "debris", name: "Debris", color: "#f97316" },
    ]);
  });

  test("loads ROI frame annotations through the websocket backend", async () => {
    const backend = createWebSocketBackend({ url: "ws://example.test" });
    const promise = backend.loadRoiFrameAnnotation("/tmp/workspace", {
      pos: 2,
      roi: 9,
      channel: 1,
      time: 4,
      z: 0,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as {
      id: string;
      type: string;
      payload: {
        workspacePath: string;
        request: { pos: number; roi: number; channel: number; time: number; z: number };
      };
    };

    expect(sent.type).toBe("load_roi_frame_annotation");
    expect(sent.payload.workspacePath).toBe("/tmp/workspace");
    expect(sent.payload.request).toEqual({
      pos: 2,
      roi: 9,
      channel: 1,
      time: 4,
      z: 0,
    });

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "load_roi_frame_annotation_result",
        payload: {
          annotation: {
            classificationLabelId: "cell",
            maskPath: "annotations/roi/Pos2/Roi9/C1_T4_Z0.png",
            updatedAt: "2026-04-02T20:00:00Z",
          },
          maskBase64Png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        },
      }),
    });

    await expect(promise).resolves.toEqual({
      annotation: {
        classificationLabelId: "cell",
        maskPath: "annotations/roi/Pos2/Roi9/C1_T4_Z0.png",
        updatedAt: "2026-04-02T20:00:00Z",
      },
      maskBase64Png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    });
  });

  test("saves ROI frame annotations through the websocket backend", async () => {
    const backend = createWebSocketBackend({ url: "ws://example.test" });
    const promise = backend.saveRoiFrameAnnotation(
      "/tmp/workspace",
      {
        pos: 2,
        roi: 9,
        channel: 1,
        time: 4,
        z: 0,
      },
      {
        classificationLabelId: "cell",
        maskBase64Png: "ZmFrZS1wbmc=",
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as {
      id: string;
      type: string;
      payload: {
        workspacePath: string;
        request: { pos: number; roi: number; channel: number; time: number; z: number };
        annotation: { classificationLabelId: string; maskBase64Png: string };
      };
    };

    expect(sent.type).toBe("save_roi_frame_annotation");
    expect(sent.payload.workspacePath).toBe("/tmp/workspace");
    expect(sent.payload.request.roi).toBe(9);
    expect(sent.payload.annotation).toEqual({
      classificationLabelId: "cell",
      maskBase64Png: "ZmFrZS1wbmc=",
    });

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "save_roi_frame_annotation_result",
        payload: {
          classificationLabelId: "cell",
          maskPath: "annotations/roi/Pos2/Roi9/C1_T4_Z0.png",
          updatedAt: "2026-04-02T20:01:00Z",
        },
      }),
    });

    await expect(promise).resolves.toEqual({
      classificationLabelId: "cell",
      maskPath: "annotations/roi/Pos2/Roi9/C1_T4_Z0.png",
      updatedAt: "2026-04-02T20:01:00Z",
    });
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
