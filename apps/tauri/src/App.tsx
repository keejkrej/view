import { useEffect, useMemo, useState } from "react";
import { BaseProvider, LightTheme } from "baseui";
import { Block } from "baseui/block/index";
import { Button } from "baseui/button/index";
import { PosViewer, normalizeGridState, type GridState } from "@view/pos-viewer";
import { Client as Styletron } from "styletron-engine-atomic";
import { Provider as StyletronProvider } from "styletron-react";
import { pickWorkspace, tauriDataSource } from "./api";
import "./app.css";

const LAST_ROOT_KEY = "view.lastRoot";
const LAST_GRID_KEY = "view.grid";
const engine = new Styletron();
const neutralTheme = {
  ...LightTheme,
  colors: {
    ...LightTheme.colors,
    backgroundPrimary: "#f7f6f2",
    backgroundSecondary: "#efede7",
    backgroundTertiary: "#e5e2d9",
    backgroundInversePrimary: "#1f1f1b",
    primaryA: "#54544c",
    primaryB: "#65655d",
    primary: "#54544c",
    contentPrimary: "#181814",
    contentSecondary: "#54544c",
    contentTertiary: "#6a6a62",
    borderOpaque: "#d9d6cc",
    borderTransparent: "rgba(84,84,76,0.16)",
    mono100: "#181814",
    mono200: "#262622",
    mono300: "#474741",
    mono500: "#7f7f77",
    mono700: "#d9d6cc",
    mono900: "#fbfaf7",
  },
};

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

  return (
    <StyletronProvider value={engine}>
      <BaseProvider theme={neutralTheme}>
        <div className="app-shell">
          <header className="app-header">
            <Block $style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <Block as="h1" margin="0" font="font650">
                Pos Viewer
              </Block>
              <Block color="contentSecondary">
                Minimal TIFF viewer for Pos workspaces with a fixed-image alignment workflow.
              </Block>
            </Block>
            <Block $style={{ display: "flex", gap: "12px" }}>
              <Button
                onClick={async () => {
                  const selected = await pickWorkspace();
                  if (selected) setRoot(selected);
                }}
              >
                Open Workspace
              </Button>
              {root ? (
                <Button kind="secondary" onClick={() => setRoot("")}>
                  Clear
                </Button>
              ) : null}
            </Block>
          </header>

          <main className="app-main">
            {root ? (
              <PosViewer
                root={root}
                dataSource={dataSource}
                initialGrid={initialGrid}
                onGridChange={(grid) => localStorage.setItem(LAST_GRID_KEY, JSON.stringify(grid))}
              />
            ) : (
              <section className="app-empty">
                <Block as="h2" margin="0 0 8px" font="font550">
                  No workspace selected
                </Block>
                <Block color="contentSecondary">
                  Select a folder that contains `Pos&#123;n&#125;` directories and TIFF frames.
                </Block>
              </section>
            )}
          </main>
        </div>
      </BaseProvider>
    </StyletronProvider>
  );
}
