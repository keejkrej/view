import { useEffect, useState } from "react";
import { useStore } from "zustand";

import type { ViewerBackend } from "@view/core-ts";
import { makeSourceKey } from "@view/core-ts";

import RoiWorkspace from "./RoiWorkspace";
import ViewerWorkspace from "./ViewerWorkspace";
import type { ViewerMode } from "./ViewNavbar";
import { setSource, setWorkspacePath, viewStore } from "./viewStore";

interface ViewAppProps {
  backend: ViewerBackend;
  pickWorkspace: () => Promise<string | null>;
  pickTif: () => Promise<string | null>;
  pickNd2: () => Promise<string | null>;
  checkRoiExists: (workspacePath: string, pos: number) => Promise<boolean>;
}

const LAST_VIEWER_MODE_KEY = "view.viewerMode";

function readStoredViewerMode(): ViewerMode {
  if (typeof window === "undefined" || !window.sessionStorage) return "align";
  const stored = window.sessionStorage.getItem(LAST_VIEWER_MODE_KEY);
  return stored === "roi" ? "roi" : "align";
}

export default function ViewApp({
  backend,
  pickWorkspace,
  pickTif,
  pickNd2,
  checkRoiExists,
}: ViewAppProps) {
  const workspacePath = useStore(viewStore, (state) => state.workspacePath);
  const source = useStore(viewStore, (state) => state.source);
  const [mode, setMode] = useState<ViewerMode>(() => readStoredViewerMode());

  useEffect(() => {
    if (typeof window === "undefined" || !window.sessionStorage) return;
    window.sessionStorage.setItem(LAST_VIEWER_MODE_KEY, mode);
  }, [mode]);

  const handlePickWorkspace = async () => {
    const selected = await pickWorkspace();
    if (selected) setWorkspacePath(selected);
  };

  const handlePickTif = async () => {
    if (!workspacePath) return;
    const selected = await pickTif();
    if (selected) setSource({ kind: "tif", path: selected });
  };

  const handlePickNd2 = async () => {
    if (!workspacePath) return;
    const selected = await pickNd2();
    if (selected) setSource({ kind: "nd2", path: selected });
  };

  return (
    mode === "align" ? (
      <ViewerWorkspace
        key={source ? `align:${makeSourceKey(source)}` : "align:no-source"}
        workspacePath={workspacePath}
        source={source}
        backend={backend}
        mode={mode}
        onModeChange={setMode}
        onPickWorkspace={handlePickWorkspace}
        onOpenTif={handlePickTif}
        onOpenNd2={handlePickNd2}
        onCheckRoiExists={checkRoiExists}
        onClearSource={() => setSource(null)}
      />
    ) : (
      <RoiWorkspace
        key="roi-workspace"
        workspacePath={workspacePath}
        source={source}
        backend={backend}
        mode={mode}
        onModeChange={setMode}
        onPickWorkspace={handlePickWorkspace}
        onOpenTif={handlePickTif}
        onOpenNd2={handlePickNd2}
        onClearSource={() => setSource(null)}
      />
    )
  );
}
