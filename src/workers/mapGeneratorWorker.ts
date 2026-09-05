/// <reference lib="webworker" />

import { generateWorldMap } from "../generator/generateWorld";
import { applyGeneratedCountries } from "../generator/mapPlacement";
import type { GeneratorSettings, MapData } from "../model/world";

type GenerationRequest = {
  type: "generate";
  requestId: number;
  settings: GeneratorSettings;
  width: number;
  height: number;
  quality: "preview" | "final";
  sourceMap?: MapData;
};

self.postMessage({ type: "ready" });

self.onmessage = (event: MessageEvent<GenerationRequest>) => {
  const { requestId, settings, width, height, quality, sourceMap } = event.data;
  if (event.data.type !== "generate") return;
  // 계산 전에 즉시 ACK를 보내 메인 화면이 Worker 수신 여부를 구분할 수 있게 한다.
  self.postMessage({ type: "accepted", requestId });
  try {
    let generated = generateWorldMap(settings, width, height, quality);
    let preparedMap: MapData | undefined;
    if (quality === "final" && sourceMap) {
      self.postMessage({ type: "progress", requestId, message: "국가와 영토를 배치하는 중입니다." });
      const placement = applyGeneratedCountries(sourceMap, generated);
      generated = placement.generated;
      preparedMap = placement.map;
    }
    self.postMessage({ type: "result", requestId, generated, preparedMap });
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
