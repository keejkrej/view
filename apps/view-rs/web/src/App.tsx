import { invoke } from "@tauri-apps/api/core";
import { PosViewerApp, createWebSocketBackend } from "@view/view";

const backend = createWebSocketBackend({ url: "ws://127.0.0.1:47834" });

export default function App() {
  return (
    <PosViewerApp
      backend={backend}
      host={{
        pickWorkspace() {
          return invoke<string | null>("pick_workspace");
        },
      }}
    />
  );
}
