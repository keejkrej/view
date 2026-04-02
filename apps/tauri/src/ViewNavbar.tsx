import { FolderOpen, X } from "lucide-react";

import type { ViewerSource } from "@view/core-ts";
import { Button } from "@view/ui";

export type ViewerMode = "align" | "roi";

interface ViewNavbarProps {
  workspacePath: string | null;
  source: ViewerSource | null;
  mode: ViewerMode;
  onModeChange: (mode: ViewerMode) => void;
  onPickWorkspace: () => Promise<void>;
  onOpenTif: () => Promise<void>;
  onOpenNd2: () => Promise<void>;
  onClearSource: () => void;
}

export default function ViewNavbar({
  workspacePath,
  source,
  mode,
  onModeChange,
  onPickWorkspace,
  onOpenTif,
  onOpenNd2,
  onClearSource,
}: ViewNavbarProps) {
  return (
    <header className="border-b border-border px-4 py-4 md:px-8">
      <div className="relative flex items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void onPickWorkspace()}>
            <span className="inline-flex items-center gap-2">
              <FolderOpen className="size-4" />
              Workspace
            </span>
          </Button>
          <Button size="sm" variant="outline" disabled={!workspacePath} onClick={() => void onOpenTif()}>
            Open TIF
          </Button>
          <Button size="sm" variant="outline" disabled={!workspacePath} onClick={() => void onOpenNd2()}>
            Open ND2
          </Button>
          {source ? (
            <Button size="sm" variant="outline" onClick={onClearSource}>
              <span className="inline-flex items-center gap-2">
                <X className="size-4" />
                Clear
              </span>
            </Button>
          ) : null}
        </div>

        <div className="pointer-events-none absolute left-1/2 flex max-w-[min(68vw,56rem)] -translate-x-1/2 flex-col text-center text-sm text-muted-foreground">
          <p className="truncate">
            {workspacePath ? `Workspace: ${workspacePath}` : "Workspace: not selected"}
          </p>
          <p className="truncate">{source ? `Source: ${source.path}` : "Source: not selected"}</p>
        </div>

        <div className="ml-auto flex items-center gap-1 rounded-xl border border-border bg-muted/35 p-1">
          <Button
            size="sm"
            variant={mode === "align" ? "default" : "ghost"}
            className="min-w-[4.5rem]"
            onClick={() => onModeChange("align")}
          >
            Align
          </Button>
          <Button
            size="sm"
            variant={mode === "roi" ? "default" : "ghost"}
            className="min-w-[4.5rem]"
            onClick={() => onModeChange("roi")}
          >
            ROI
          </Button>
        </div>
      </div>
    </header>
  );
}
