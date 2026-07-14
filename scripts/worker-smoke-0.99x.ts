import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { defaultGeneratorSettings } from "../src/model/world";

const files = await readdir(new URL("../dist/assets/", import.meta.url));
const workerName = files.find((name) => name.startsWith("mapGeneratorWorker-") && name.endsWith(".js"));
if (!workerName) throw new Error("빌드된 지도 생성 Worker를 찾지 못했습니다.");
const workerUrl = new URL(`../dist/assets/${workerName}`, import.meta.url).href;
const wrapperUrl = pathToFileURL(resolve("scripts/node-worker-wrapper.mjs"));
const worker = new Worker(wrapperUrl, { type: "module", workerData: { url: workerUrl } });
const settings = {
  ...defaultGeneratorSettings(),
  analysisResolution: 128 as const,
  renderResolution: 256 as const,
  gridWidth: 128,
  gridHeight: 64,
  generateCountries: false,
};
const messages: string[] = [];
const startedAt = performance.now();
await new Promise<void>((resolvePromise, rejectPromise) => {
  const timeout = setTimeout(() => {
    void worker.terminate();
    rejectPromise(new Error("지도 생성 Worker 스모크 테스트 시간 초과"));
  }, 20_000);
  worker.on("message", (data: { type?: string; requestId?: number; generated?: { gridWidth: number; gridHeight: number; contours: unknown[] }; preview?: { width: number; height: number; pixels: Uint8ClampedArray }; error?: string }) => {
    messages.push(String(data.type ?? "unknown"));
    if (data.type === "ready") worker.postMessage({ type: "generate", requestId: 99, settings, width: 160, height: 100, quality: "preview" });
    else if (data.type === "error") {
      clearTimeout(timeout);
      void worker.terminate();
      rejectPromise(new Error(data.error ?? "Worker 오류"));
    } else if (data.type === "result") {
      clearTimeout(timeout);
      if (!data.generated || data.generated.gridWidth !== 128 || data.generated.gridHeight !== 64)
        rejectPromise(new Error("Worker 결과 격자 오류"));
      else if (data.generated.contours.length >= 20_000)
        rejectPromise(new Error(`Worker 미리보기 등고선 예산 초과: ${data.generated.contours.length}`));
      else if (!data.preview || data.preview.width < 128 || data.preview.height < 64 || data.preview.pixels.length !== data.preview.width * data.preview.height * 4)
        rejectPromise(new Error("Worker가 표시 가능한 미리보기 래스터를 반환하지 않음"));
      else resolvePromise();
      void worker.terminate();
    }
  });
  worker.on("error", (error) => {
    clearTimeout(timeout);
    rejectPromise(error);
  });
});
if (messages.join(",") !== "ready,accepted,result") throw new Error(`Worker 응답 순서 오류: ${messages.join(",")}`);
console.log(JSON.stringify({ status: "passed", messages, elapsedMs: Number((performance.now() - startedAt).toFixed(1)) }, null, 2));
