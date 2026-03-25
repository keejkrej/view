import { useEffect, useMemo, useState } from "react";
import { normalizeGridState, type GridState } from "@view/pos-viewer";
import { pickWorkspace, tauriDataSource } from "./api";
import ViewerWorkspace from "./ViewerWorkspace";
import "./app.css";

const LAST_ROOT_KEY = "view.lastRoot";
const LAST_GRID_KEY = "view.grid";

function readStoredGrid(): GridState | undefined {
  try {
    const raw = localStorage.getItem(LAST_GRID_KEY);
    if (!raw) return undefined;
    return normalizeGridState(JSON.parse(raw) as Partial<GridState>);
  } catch {
    return undefined;
  }
}

export default function App() {
  const [root, setRoot] = useState<string>(() => localStorage.getItem(LAST_ROOT_KEY) ?? "");
  const [initialGrid] = useState<GridState | undefined>(() => readStoredGrid());

  useEffect(() => {
    if (root) {
      localStorage.setItem(LAST_ROOT_KEY, root);
    } else {
      localStorage.removeItem(LAST_ROOT_KEY);
    }
  }, [root]);

  const dataSource = useMemo(() => tauriDataSource, []);

  const handlePickWorkspace = async () => {
    const selected = await pickWorkspace();
    if (selected) setRoot(selected);
  };

  return (
    <ViewerWorkspace
      root={root}
      dataSource={dataSource}
      initialGrid={initialGrid}
      onGridChange={(grid) => localStorage.setItem(LAST_GRID_KEY, JSON.stringify(grid))}
      onOpenWorkspace={handlePickWorkspace}
      onClearWorkspace={() => setRoot("")}
    />
  );
}
