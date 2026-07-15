/// <reference lib="webworker" />

import { generateWorldMap } from "../generator/generateWorld";
import type { GeneratorSettings } from "../model/world";
import { createGeneratedPreviewRaster } from "../generator/previewRaster";

type GenerationRequest = {
  type: "generate";
  requestId: number;
  settings: GeneratorSettings;
  width: number;
  height: number;
  quality: "preview" | "final";
};

self.postMessage({ type: "ready" });

self.onmessage = (event: MessageEvent<GenerationRequest>) => {
  const { requestId, settings, width, height, quality } = event.data;
  if (event.data.type !== "generate") return;
  // 계산 전에 즉시 ACK를 보내 메인 화면이 Worker 수신 여부를 구분할 수 있게 한다.
  self.postMessage({ type: "accepted", requestId });
  try {
    const generated = generateWorldMap(settings, width, height, quality);
    const preview = createGeneratedPreviewRaster(generated, quality === "preview" ? 768 : 512);
    self.postMessage({ type: "result", requestId, generated, preview }, [preview.pixels.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error ?? "알 수 없는 지도 생성 오류"),
    });
  }
};

export {};
