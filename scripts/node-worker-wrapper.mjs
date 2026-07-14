import { parentPort, workerData } from "node:worker_threads";

globalThis.self = {
  postMessage(message) { parentPort.postMessage(message); },
  onmessage: null,
};
parentPort.on("message", (data) => globalThis.self.onmessage?.({ data }));
await import(workerData.url);
