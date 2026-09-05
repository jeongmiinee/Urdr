/// <reference lib="webworker" />

import { rebuildGeneratedMapData } from "../generator/generateWorld";
import { refreshSurfaceRegions } from "../generator/surfaceVectors";
import type { GeneratedMapData } from "../model/world";

type BrushRebuildRequest = {
  requestId: number;
  generated: GeneratedMapData;
  mode: "terrain" | "elevation";
};

self.onmessage = (event: MessageEvent<BrushRebuildRequest>) => {
  const { requestId, generated, mode } = event.data;
  try {
    const rebuilt = mode === "terrain"
      ? refreshSurfaceRegions(generated, "final")
      : rebuildGeneratedMapData(generated, generated.elevationMap, undefined, generated.seaLevel);
    self.postMessage({ type: "result", requestId, generated: rebuilt });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
