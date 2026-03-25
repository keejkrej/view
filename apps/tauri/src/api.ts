import { invoke } from "@tauri-apps/api/core";
import type { FrameRequest, FrameResult, PosViewerDataSource, WorkspaceScan } from "@view/pos-viewer";

interface TauriFrameResponse {
  width: number;
  height: number;
  data: number[];
}

export async function pickWorkspace(): Promise<string | null> {
  return invoke<string | null>("pick_workspace");
}

export async function saveBbox(root: string, pos: number, csv: string): Promise<{ ok: boolean; error?: string }> {
  return invoke<{ ok: boolean; error?: string }>("save_bbox", { root, pos, csv });
}

export const tauriDataSource: PosViewerDataSource = {
  scanWorkspace(root: string): Promise<WorkspaceScan> {
    return invoke<WorkspaceScan>("scan_workspace", { root });
  },
  async loadFrame(root: string, request: FrameRequest): Promise<FrameResult> {
    const response = await invoke<TauriFrameResponse>("load_frame", { root, request });
    return {
      width: response.width,
      height: response.height,
      pixels: Uint16Array.from(response.data),
      pixelType: "uint16",
    };
  },
};
