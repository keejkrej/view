import { Effect } from "effect";

import type {
  ContrastWindow,
  FrameResult,
  RoiFrameRequest,
  RoiWorkspaceScan,
  ViewerBackend,
  ViewerSelection,
  ViewerSource,
} from "@view/core-ts";
import {
  clamp,
  coerceSelection,
  createSelection,
  getFrameContrastDomain,
} from "@view/core-ts";

import type { ContrastMode } from "./viewStore";

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === "string" && error.length > 0 ? error : fallback);
}

function contrastWindowForFrame(frame: FrameResult | null): ContrastWindow {
  if (!frame) return { min: 0, max: 255 };
  return frame.contrastDomain ?? getFrameContrastDomain(frame);
}

export function toErrorMessage(error: unknown): string {
  return toError(error, "Unknown viewer error").message;
}

export function scanSourceEffect(backend: ViewerBackend, source: ViewerSource) {
  return Effect.tryPromise({
    try: () => backend.scanSource(source),
    catch: (error) => toError(error, "Failed to scan source"),
  }).pipe(
    Effect.map((scan) => ({
      scan,
      selection: coerceSelection(scan, createSelection(scan)),
    })),
    Effect.withSpan("viewer.scan-source"),
  );
}

export function scanRoiWorkspaceEffect(backend: ViewerBackend, workspacePath: string) {
  return Effect.tryPromise({
    try: () => backend.scanRoiWorkspace(workspacePath),
    catch: (error) => toError(error, "Failed to scan ROI workspace"),
  }).pipe(
    Effect.map((scan) => ({ scan })),
    Effect.withSpan("viewer.scan-roi-workspace"),
  );
}

export function loadFrameEffect(
  backend: ViewerBackend,
  source: ViewerSource,
  selection: ViewerSelection,
  contrast: {
    mode: ContrastMode;
    min: number;
    max: number;
  },
) {
  const requestedContrast =
    contrast.mode === "manual"
      ? ({
          min: contrast.min,
          max: contrast.max,
        } satisfies ContrastWindow)
      : undefined;

  return Effect.tryPromise({
    try: () =>
      backend.loadFrame(
        source,
        selection,
        requestedContrast ? { contrast: requestedContrast } : undefined,
      ),
    catch: (error) => toError(error, "Failed to load frame"),
  }).pipe(
    Effect.map((frame) => {
      const domain = contrastWindowForFrame(frame);
      const applied = frame.appliedContrast ?? frame.suggestedContrast ?? domain;

      return {
        frame,
        contrastMin: clamp(
          Math.round(applied.min),
          domain.min,
          Math.max(domain.min, domain.max - 1),
        ),
        contrastMax: clamp(
          Math.round(applied.max),
          Math.min(domain.min + 1, domain.max),
          domain.max,
        ),
      };
    }),
    Effect.withSpan("viewer.load-frame"),
  );
}

export function loadRoiFrameEffect(
  backend: ViewerBackend,
  workspacePath: string,
  request: RoiFrameRequest,
  contrast: {
    mode: ContrastMode;
    min: number;
    max: number;
  },
) {
  const requestedContrast =
    contrast.mode === "manual"
      ? ({
          min: contrast.min,
          max: contrast.max,
        } satisfies ContrastWindow)
      : undefined;

  return Effect.tryPromise({
    try: () =>
      backend.loadRoiFrame(
        workspacePath,
        request,
        requestedContrast ? { contrast: requestedContrast } : undefined,
      ),
    catch: (error) => toError(error, "Failed to load ROI frame"),
  }).pipe(
    Effect.map((frame) => {
      const domain = contrastWindowForFrame(frame);
      const applied = frame.appliedContrast ?? frame.suggestedContrast ?? domain;

      return {
        frame,
        contrastMin: clamp(
          Math.round(applied.min),
          domain.min,
          Math.max(domain.min, domain.max - 1),
        ),
        contrastMax: clamp(
          Math.round(applied.max),
          Math.min(domain.min + 1, domain.max),
          domain.max,
        ),
      };
    }),
    Effect.withSpan("viewer.load-roi-frame"),
  );
}

export function saveBboxEffect(
  backend: ViewerBackend,
  {
    workspacePath,
    source,
    pos,
    csv,
  }: {
    workspacePath: string;
    source: ViewerSource;
    pos: number;
    csv: string;
  },
) {
  return Effect.tryPromise({
    try: () => backend.saveBbox(workspacePath, source, pos, csv),
    catch: (error) => toError(error, "Failed to save bbox CSV"),
  }).pipe(Effect.withSpan("viewer.save-bbox"));
}

export function cropRoiEffect(
  backend: ViewerBackend,
  {
    workspacePath,
    source,
    pos,
  }: {
    workspacePath: string;
    source: ViewerSource;
    pos: number;
  },
) {
  return Effect.tryPromise({
    try: () => backend.cropRoi(workspacePath, source, pos, "tiff"),
    catch: (error) => toError(error, "Failed to crop ROI TIFFs"),
  }).pipe(Effect.withSpan("viewer.crop-roi"));
}
