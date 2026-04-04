import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import type {
  AnnotationLabel,
  CropOutputFormat,
  CropRoiProgressEvent,
  CropRoiResponse,
  FrameRequest,
  FrameResult,
  LoadedRoiFrameAnnotation,
  LoadFrameOptions,
  RoiFrameAnnotation,
  RoiFrameAnnotationPayload,
  RoiFrameRequest,
  RoiWorkspaceScan,
  SaveBboxResponse,
  ViewerDataPort,
  ViewerHostPort,
  ViewerSource,
  WorkspaceScan,
} from "@view/contracts";

interface FramePayload {
  width: number;
  height: number;
  data_base64: string;
  pixel_type?: FrameResult["pixelType"];
  contrast_domain?: FrameResult["contrastDomain"];
  suggested_contrast?: FrameResult["suggestedContrast"];
  applied_contrast?: FrameResult["appliedContrast"];
}

const CROP_PROGRESS_EVENT = "view://crop-progress";

function decodeBase64ToBytes(value: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("Base64 decoding is unavailable in this host");
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toFrameResult(payload: FramePayload): FrameResult {
  return {
    width: payload.width,
    height: payload.height,
    pixels: decodeBase64ToBytes(payload.data_base64),
    pixelType: payload.pixel_type ?? "uint8",
    contrastDomain: payload.contrast_domain,
    suggestedContrast: payload.suggested_contrast,
    appliedContrast: payload.applied_contrast,
  };
}

function makeRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface TauriDesktopPorts {
  dataPort: ViewerDataPort;
  hostPort: ViewerHostPort;
}

export function createTauriDesktopPorts(): TauriDesktopPorts {
  const cropProgressListeners = new Set<(event: CropRoiProgressEvent) => void>();
  let cropProgressUnlistenPromise: Promise<(() => void) | null> | null = null;

  const ensureCropProgressListener = () => {
    if (!cropProgressUnlistenPromise) {
      cropProgressUnlistenPromise = listen<CropRoiProgressEvent>(CROP_PROGRESS_EVENT, (event) => {
        for (const listener of cropProgressListeners) {
          listener(event.payload);
        }
      }).catch(() => null);
    }

    return cropProgressUnlistenPromise;
  };

  const dataPort: ViewerDataPort = {
    scanSource(source: ViewerSource): Promise<WorkspaceScan> {
      return invoke("scan_source", { source });
    },

    loadFrame(source: ViewerSource, request: FrameRequest, options?: LoadFrameOptions) {
      return invoke<FramePayload>("load_frame", {
        source,
        request,
        contrast: options?.contrast ?? null,
      }).then(toFrameResult);
    },

    scanRoiWorkspace(workspacePath: string): Promise<RoiWorkspaceScan> {
      return invoke("scan_roi_workspace", { workspace_path: workspacePath });
    },

    loadAnnotationLabels(workspacePath: string): Promise<AnnotationLabel[]> {
      return invoke("load_annotation_labels", { workspace_path: workspacePath });
    },

    saveAnnotationLabels(workspacePath: string, labels: AnnotationLabel[]): Promise<AnnotationLabel[]> {
      return invoke("save_annotation_labels", { workspace_path: workspacePath, labels });
    },

    loadRoiFrame(workspacePath: string, request: RoiFrameRequest, options?: LoadFrameOptions) {
      return invoke<FramePayload>("load_roi_frame", {
        workspace_path: workspacePath,
        request,
        contrast: options?.contrast ?? null,
      }).then(toFrameResult);
    },

    loadRoiFrameAnnotation(
      workspacePath: string,
      request: RoiFrameRequest,
    ): Promise<LoadedRoiFrameAnnotation> {
      return invoke("load_roi_frame_annotation", { workspace_path: workspacePath, request });
    },

    saveRoiFrameAnnotation(
      workspacePath: string,
      request: RoiFrameRequest,
      annotation: RoiFrameAnnotationPayload,
    ): Promise<RoiFrameAnnotation> {
      return invoke("save_roi_frame_annotation", {
        workspace_path: workspacePath,
        request,
        annotation,
      });
    },

    saveBbox(
      workspacePath: string,
      source: ViewerSource,
      pos: number,
      csv: string,
    ): Promise<SaveBboxResponse> {
      return invoke("save_bbox", {
        workspace_path: workspacePath,
        source,
        pos,
        csv,
      });
    },

    cropRoi(
      workspacePath: string,
      source: ViewerSource,
      pos: number,
      format: CropOutputFormat,
    ): Promise<CropRoiResponse> {
      const requestId = makeRequestId();
      return invoke("crop_roi", {
        workspace_path: workspacePath,
        source,
        pos,
        format,
        request_id: requestId,
      });
    },

    onCropRoiProgress(listener) {
      cropProgressListeners.add(listener);
      void ensureCropProgressListener();

      return () => {
        cropProgressListeners.delete(listener);
      };
    },
  };

  const hostPort: ViewerHostPort = {
    pickWorkspace() {
      return invoke("pick_workspace");
    },

    pickTifDirectory() {
      return invoke("pick_tif");
    },

    pickNd2File() {
      return invoke("pick_nd2");
    },

    roiPosExists(workspacePath: string, pos: number) {
      return invoke("roi_pos_exists", {
        workspace_path: workspacePath,
        pos,
      });
    },
  };

  return { dataPort, hostPort };
}
