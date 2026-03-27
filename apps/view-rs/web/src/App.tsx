import { invoke } from "@tauri-apps/api/core";
import { createWebSocketBackend } from "@view/view";

import ViewApp from "./ViewApp";

const backend = createWebSocketBackend({ url: "ws://127.0.0.1:47834" });

export default function App() {
  return (
    <ViewApp
      backend={backend}
      pickWorkspace={() => invoke<string | null>("pick_workspace")}
      pickTif={() => invoke<string | null>("pick_tif")}
      pickNd2={() => invoke<string | null>("pick_nd2")}
    />
  );
}
