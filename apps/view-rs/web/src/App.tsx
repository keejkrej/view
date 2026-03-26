import { invoke } from "@tauri-apps/api/core";
import { createWebSocketBackend } from "@view/view";

import PosViewerApp from "./PosViewerApp";

const backend = createWebSocketBackend({ url: "ws://127.0.0.1:47834" });

export default function App() {
  return (
    <PosViewerApp
      backend={backend}
      pickWorkspace={() => invoke<string | null>("pick_workspace")}
    />
  );
}
