import { useEffect, useMemo, useState } from "react";
import { FolderOpen } from "lucide-react";
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

  if (!root) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-10 text-white">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.16),transparent_26%),radial-gradient(circle_at_bottom_right,rgba(249,115,22,0.18),transparent_28%),linear-gradient(140deg,#020611_0%,#09121f_45%,#15233e_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)] bg-[size:26px_26px] opacity-20" />

        <section className="relative z-10 w-full max-w-3xl rounded-[2rem] border border-white/10 bg-white/8 p-8 shadow-[0_32px_120px_rgba(0,0,0,0.45)] backdrop-blur-2xl md:p-10">
          <div className="max-w-2xl">
            <p className="text-[0.72rem] font-semibold uppercase tracking-[0.24em] text-sky-200/80">
              View
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-white md:text-6xl">
              Pos workspace viewer with a proper desktop layout.
            </h1>
            <p className="mt-4 text-base leading-7 text-white/62 md:text-lg">
              Open a workspace containing <code className="rounded bg-white/10 px-1.5 py-0.5 text-white">Pos{"{n}"}</code> folders
              and TIFF frames. The renderer keeps the fixed-image alignment workflow, but the interface is rebuilt around a stronger desktop shell.
            </p>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handlePickWorkspace()}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-white px-5 text-sm font-medium text-slate-950 shadow-[0_10px_40px_rgba(255,255,255,0.2)] transition hover:bg-slate-100"
            >
              <FolderOpen className="size-4" />
              Open Workspace
            </button>
            <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/52">
              Last workspace is restored automatically after selection.
            </div>
          </div>
        </section>
      </div>
    );
  }

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
