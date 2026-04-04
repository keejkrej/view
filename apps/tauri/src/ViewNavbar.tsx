import { useEffect, useState } from "react";
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
  const [openDataModalOpen, setOpenDataModalOpen] = useState(false);

  useEffect(() => {
    if (!openDataModalOpen) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenDataModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openDataModalOpen]);

  useEffect(() => {
    if (!workspacePath) {
      setOpenDataModalOpen(false);
    }
  }, [workspacePath]);

  const handleOpenTif = async () => {
    setOpenDataModalOpen(false);
    await onOpenTif();
  };

  const handleOpenNd2 = async () => {
    setOpenDataModalOpen(false);
    await onOpenNd2();
  };

  return (
    <>
      <header className="border-b border-border px-4 py-4 md:px-8">
        <div className="relative flex items-center gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void onPickWorkspace()}>
              <span className="inline-flex items-center gap-2">
                <FolderOpen className="size-4" />
                Workspace
              </span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!workspacePath}
              onClick={() => setOpenDataModalOpen(true)}
            >
              Open Data
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

      {openDataModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setOpenDataModalOpen(false);
            }
          }}
        >
          <div
            className="w-full max-w-xl overflow-hidden rounded-[1.75rem] border border-border/80 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--color-card)_94%,white)_0%,var(--color-card)_100%)] shadow-[0_24px_80px_rgba(0,0,0,0.35)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="open-data-title"
          >
            <div className="border-b border-border/70 px-6 py-5">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-3">
                  <span className="inline-flex items-center rounded-full border border-border/70 bg-muted/60 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Select A Format
                  </span>
                  <div className="space-y-1.5">
                    <h2 id="open-data-title" className="text-[1.75rem] font-medium tracking-tight text-foreground">
                      Open Data
                    </h2>
                    <p className="max-w-lg text-sm leading-6 text-muted-foreground">
                      Choose the source format to load into the selected workspace.
                    </p>
                  </div>
                </div>

                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="shrink-0 rounded-full"
                  aria-label="Close open data modal"
                  onClick={() => setOpenDataModalOpen(false)}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>

            <div className="p-6">
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  className="group flex min-h-28 w-full items-center justify-center rounded-2xl border border-border/70 bg-muted/[0.18] px-6 py-5 text-center transition-colors hover:border-primary/35 hover:bg-primary/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => void handleOpenTif()}
                >
                  <span className="text-lg font-medium tracking-[0.02em] text-foreground transition-colors group-hover:text-primary">
                    TIFF
                  </span>
                </button>

                <button
                  type="button"
                  className="group flex min-h-28 w-full items-center justify-center rounded-2xl border border-border/70 bg-muted/[0.18] px-6 py-5 text-center transition-colors hover:border-primary/35 hover:bg-primary/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => void handleOpenNd2()}
                >
                  <span className="text-lg font-medium tracking-[0.02em] text-foreground transition-colors group-hover:text-primary">
                    ND2
                  </span>
                </button>
              </div>
            </div>

            <div className="flex justify-end border-t border-border/70 px-6 py-4">
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => setOpenDataModalOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
