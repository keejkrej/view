import { useStore } from "zustand";

import type { ViewerBackend } from "@view/core-ts";
import { makeSourceKey } from "@view/core-ts";

import ViewerWorkspace from "./ViewerWorkspace";
import { setSource, setWorkspacePath, viewStore } from "./viewStore";

interface ViewAppProps {
  backend: ViewerBackend;
  pickWorkspace: () => Promise<string | null>;
  pickTif: () => Promise<string | null>;
  pickNd2: () => Promise<string | null>;
}

export default function ViewApp({ backend, pickWorkspace, pickTif, pickNd2 }: ViewAppProps) {
  const workspacePath = useStore(viewStore, (state) => state.workspacePath);
  const source = useStore(viewStore, (state) => state.source);

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
    <ViewerWorkspace
      key={source ? makeSourceKey(source) : "no-source"}
      workspacePath={workspacePath}
      source={source}
      backend={backend}
      onPickWorkspace={handlePickWorkspace}
      onOpenTif={handlePickTif}
      onOpenNd2={handlePickNd2}
      onClearSource={() => setSource(null)}
    />
  );
}
