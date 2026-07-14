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
  openProjectFile: () => Promise<{ name: string; text: string } | null>;
  saveProjectFile: (payload: { suggestedName: string; text: string }) => Promise<boolean>;
  getRuntimeMetrics: () => Promise<RuntimeMetrics>;
  loadBundledDemo: () => Promise<string>;
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

export async function openTextFileFromPlatform(): Promise<{ name: string; text: string } | null> {
  return window.worldArchiveDesktop?.openProjectFile() ?? null;
}

export async function saveTextFileToPlatform(suggestedName: string, text: string): Promise<boolean> {
  if (!window.worldArchiveDesktop) return false;
  return window.worldArchiveDesktop.saveProjectFile({ suggestedName, text });
}

export async function getRuntimeMetrics(): Promise<RuntimeMetrics | null> {
  return window.worldArchiveDesktop?.getRuntimeMetrics() ?? null;
}

export async function requestQuitFromPlatform(): Promise<boolean> {
  return window.worldArchiveDesktop?.quitApp() ?? false;
}

export async function loadBundledDemoText(): Promise<string> {
  if (window.worldArchiveDesktop) return window.worldArchiveDesktop.loadBundledDemo();
  const response = await fetch(`${import.meta.env.BASE_URL}demoProjectData.json.gz`);
  if (!response.ok || !response.body) throw new Error("압축 데모 데이터를 읽지 못했습니다.");
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
