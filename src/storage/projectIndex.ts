export const PROJECT_PREFIX = "world-map-editor-v0.99-project-";

const INDEX_KEY = "world-map-editor-v0.99-index";
const LEGACY_INDEX_KEYS = [
  "world-map-editor-v0.97-index",
  "world-map-editor-v0.96-index",
  "world-map-editor-v0.95-index",
  "world-map-editor-v0.94-index",
  "world-map-editor-v0.93-index",
  "world-map-editor-v0.92-index",
  "world-map-editor-v0.91-index",
  "world-map-editor-v0.9-index",
  "world-map-editor-v0.8-index",
  "world-map-editor-v0.7-index",
  "world-map-editor-v0.6-index",
  "world-map-editor-v0.5-index",
  "world-map-editor-v0.4-index",
];

export const LEGACY_PROJECT_PREFIXES = [
  "world-map-editor-v0.97-project-",
  "world-map-editor-v0.96-project-",
  "world-map-editor-v0.95-project-",
  "world-map-editor-v0.94-project-",
  "world-map-editor-v0.93-project-",
  "world-map-editor-v0.92-project-",
  "world-map-editor-v0.91-project-",
  "world-map-editor-v0.9-project-",
  "world-map-editor-v0.8-project-",
  "world-map-editor-v0.7-project-",
  "world-map-editor-v0.6-project-",
  "world-map-editor-v0.5-project-",
  "world-map-editor-v0.4-project-",
];

export type RecentProject = {
  id: string;
  title: string;
  lastModifiedDate: string;
};

function parseIndex(key: string): RecentProject[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as RecentProject[];
  } catch {
    return [];
  }
}

export function readProjectIndex(): RecentProject[] {
  const items = [
    parseIndex(INDEX_KEY),
    ...LEGACY_INDEX_KEYS.map(parseIndex),
  ].flat();
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}

export function writeProjectIndex(items: RecentProject[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(items.slice(0, 12)));
}
