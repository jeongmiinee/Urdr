import type { MapData, WorldProject } from "./world";

export function activeMap(project: WorldProject): MapData | null {
  return (
    project.maps.find((map) => map.id === project.activeMapId) ??
    project.maps[0] ??
    null
  );
}
