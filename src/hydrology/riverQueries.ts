import type { GeneratedMapData, GeneratedRiverEdge, Point } from "../model/world";

export function renderedRiverEdges(data: GeneratedMapData): GeneratedRiverEdge[] {
  return data.riverGraph?.edges.filter((edge) => edge.render && edge.centerline.length >= 2) ?? [];
}

export function riverCellMask(data: GeneratedMapData): Uint8Array {
  const mask = new Uint8Array(data.gridWidth * data.gridHeight);
  const cellWidth = data.worldWidth / Math.max(1, data.gridWidth);
  const cellHeight = data.worldHeight / Math.max(1, data.gridHeight);
  const mark = (point: Point) => {
    const x = Math.max(0, Math.min(data.gridWidth - 1, Math.floor(point.x / cellWidth)));
    const y = Math.max(0, Math.min(data.gridHeight - 1, Math.floor(point.y / cellHeight)));
    mask[y * data.gridWidth + x] = 1;
  };
  for (const edge of renderedRiverEdges(data)) {
    for (let index = 1; index < edge.centerline.length; index += 1) {
      const start = edge.centerline[index - 1];
      const end = edge.centerline[index];
      const steps = Math.max(1, Math.ceil(Math.max(
        Math.abs(end.x - start.x) / Math.max(1e-9, cellWidth),
        Math.abs(end.y - start.y) / Math.max(1e-9, cellHeight),
      )));
      for (let step = 0; step <= steps; step += 1) {
        const ratio = step / steps;
        mark({ x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio });
      }
    }
  }
  return mask;
}

export function sampledRiverBoundaryPoints(data: GeneratedMapData, budget = 4_096): Point[] {
  const edges = renderedRiverEdges(data);
  const count = edges.reduce((sum, edge) => sum + edge.centerline.length, 0);
  const stride = Math.max(1, Math.ceil(count / Math.max(1, budget)));
  const result: Point[] = [];
  let cursor = 0;
  for (const edge of edges) for (let index = 0; index < edge.centerline.length; index += 1) {
    if (index === 0 || index === edge.centerline.length - 1 || cursor % stride === 0)
      result.push(edge.centerline[index]);
    cursor += 1;
  }
  return result;
}
