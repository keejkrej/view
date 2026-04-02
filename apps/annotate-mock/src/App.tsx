import {
  RoiAnnotationEditor,
  createEmptyMask,
  type RoiAnnotationValue,
} from "@view/annotate";
import type { AnnotationLabel, FrameResult } from "@view/core-ts";
import { Button } from "@view/ui";
import { useMemo, useState } from "react";

function createSampleFrame(width: number, height: number): FrameResult {
  const pixels = new Uint8ClampedArray(width * height);
  const centerX = width / 2;
  const centerY = height / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * width + x;
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const radial = Math.max(0, 255 - distance * 1.35);
      const stripe = 30 * Math.sin((x / width) * Math.PI * 8);
      const wave = 24 * Math.cos((y / height) * Math.PI * 6);
      pixels[offset] = Math.max(0, Math.min(255, Math.round(radial + stripe + wave)));
    }
  }

  return {
    width,
    height,
    pixels,
  };
}

const DEFAULT_LABELS: AnnotationLabel[] = [
  { id: "cell", name: "Cell", color: "#22c55e" },
  { id: "debris", name: "Debris", color: "#f97316" },
  { id: "artifact", name: "Artifact", color: "#38bdf8" },
];

export default function App() {
  const frame = useMemo(() => createSampleFrame(256, 256), []);
  const [labels, setLabels] = useState<AnnotationLabel[]>(DEFAULT_LABELS);
  const [savedValue, setSavedValue] = useState<RoiAnnotationValue>({
    classificationLabelId: DEFAULT_LABELS[0]?.id ?? null,
    mask: createEmptyMask(frame.width, frame.height),
  });
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState(0);

  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground md:px-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-border bg-card/80 px-5 py-4 shadow-sm">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Annotate Mock</h1>
            <p className="text-sm text-muted-foreground">
              Web-only harness for validating image rendering, brush behavior, labels, and save/reset flows in <code>@view/annotate</code>.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-9 px-3 text-xs"
              onClick={() => {
                setSavedValue({
                  classificationLabelId: DEFAULT_LABELS[0]?.id ?? null,
                  mask: createEmptyMask(frame.width, frame.height),
                });
                setLabels(DEFAULT_LABELS);
                setSavedAt(null);
                setSessionKey((current) => current + 1);
              }}
            >
              Reset demo
            </Button>
          </div>
        </header>

        <section className="rounded-[1.75rem] border border-border bg-card shadow-sm">
          <RoiAnnotationEditor
            frame={frame}
            labels={labels}
            initialValue={savedValue}
            resetKey={sessionKey}
            title="Mock ROI Annotation"
            subtitle={`Sample frame | 256 x 256 | Last save: ${savedAt ?? "not saved yet"}`}
            onClose={() => {
              setSessionKey((current) => current + 1);
            }}
            onSave={async (value) => {
              setSavedValue({
                classificationLabelId: value.classificationLabelId,
                mask: value.mask.slice(),
              });
              setSavedAt(new Date().toLocaleTimeString());
            }}
            onLabelsChange={async (nextLabels) => {
              setLabels(nextLabels);
              return nextLabels;
            }}
          />
        </section>
      </div>
    </main>
  );
}
