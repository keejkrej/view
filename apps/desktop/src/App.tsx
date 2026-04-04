import { createTauriDesktopPorts } from "@view/host-tauri";
import { ViewApp } from "@view/react";

const ports = createTauriDesktopPorts();

export default function App() {
  return <ViewApp dataPort={ports.dataPort} hostPort={ports.hostPort} />;
}
