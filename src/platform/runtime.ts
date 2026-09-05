export type RuntimeProcessMetric = {
  pid: number;
  type: string;
  cpuPercent: number;
  idleWakeupsPerSecond: number;
  memory: { workingSetSize?: number; peakWorkingSetSize?: number; privateBytes?: number; sharedBytes?: number } | null;
};

export type RuntimeMetrics = {
  capturedAt: string;
  mainMemory: { residentSet?: number; private?: number; shared?: number };
  processes: RuntimeProcessMetric[];
};

export type DesktopBridge = {
  platform: string;
  openProjectFile: (language: "ko" | "en") => Promise<{ name: string; text?: string; bytes?: Uint8Array } | null>;
  saveProjectFile: (payload: { suggestedName: string; text: string; language: "ko" | "en" }) => Promise<boolean>;
  saveBinaryFile: (payload: { suggestedName: string; bytes: Uint8Array; language: "ko" | "en" }) => Promise<boolean>;
  getRuntimeMetrics: () => Promise<RuntimeMetrics>;
  loadBundledDemo: (language: "ko" | "en") => Promise<string>;
  onForwardedProject: (callback: (project: { name: string; text?: string; bytes?: Uint8Array }) => void) => () => void;
  quitApp: () => Promise<boolean>;
};

declare global {
  interface Window {
    worldArchiveDesktop?: DesktopBridge;
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.worldArchiveDesktop);
}

export async function openProjectFileFromPlatform(): Promise<{ name: string; text?: string; bytes?: Uint8Array } | null> {
  const language = window.localStorage.getItem("world-archive-language") === "en" ? "en" : "ko";
  return window.worldArchiveDesktop?.openProjectFile(language) ?? null;
}

export async function saveTextFileToPlatform(suggestedName: string, text: string): Promise<boolean> {
  if (!window.worldArchiveDesktop) return false;
  const language = window.localStorage.getItem("world-archive-language") === "en" ? "en" : "ko";
  return window.worldArchiveDesktop.saveProjectFile({ suggestedName, text, language });
}

export async function saveBinaryFileToPlatform(suggestedName: string, bytes: Uint8Array): Promise<boolean> {
  if (!window.worldArchiveDesktop) return false;
  const language = window.localStorage.getItem("world-archive-language") === "en" ? "en" : "ko";
  return window.worldArchiveDesktop.saveBinaryFile({ suggestedName, bytes, language });
}

export async function getRuntimeMetrics(): Promise<RuntimeMetrics | null> {
  return window.worldArchiveDesktop?.getRuntimeMetrics() ?? null;
}

export async function requestQuitFromPlatform(): Promise<boolean> {
  return window.worldArchiveDesktop?.quitApp() ?? false;
}

export async function loadBundledDemoText(language: "ko" | "en" = "ko"): Promise<string> {
  if (window.worldArchiveDesktop) return window.worldArchiveDesktop.loadBundledDemo(language);
  const filename = language === "en" ? "demoProjectData.en.json.gz" : "demoProjectData.json.gz";
  const response = await fetch(`${import.meta.env.BASE_URL}${filename}`);
  if (!response.ok || !response.body) throw new Error("압축 데모 데이터를 읽지 못했습니다.");
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export function subscribeToForwardedProject(
  callback: (project: { name: string; text?: string; bytes?: Uint8Array }) => void,
): () => void {
  return window.worldArchiveDesktop?.onForwardedProject(callback) ?? (() => {});
}
