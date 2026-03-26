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
    const promise = backend.scanWorkspace("/tmp/workspace");

    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = FakeWebSocket.instance;
    expect(socket).not.toBeNull();
    const sent = JSON.parse(socket!.sent[0] ?? "{}") as { id: string; type: string };

    expect(sent.type).toBe("scan_workspace");

    socket!.emit("message", {
      data: JSON.stringify({
        id: sent.id,
        type: "scan_workspace_result",
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
    const promise = backend.saveBbox("/tmp/workspace", 7, "crop,x,y,w,h");

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
});
