import type { GeneratorSettings, WaterType } from "../model/world";

/** 지도 가장자리와 연결된 저지 수역은 해수, 육지에 둘러싸인 수역은 담수로 분류한다. */
export function classifyWaterBodies(
  elevation: number[],
  width: number,
  height: number,
  seaLevel: number,
  settings: GeneratorSettings,
): WaterType[] {
  const result = new Array<WaterType>(elevation.length).fill("land");
  const salt = new Uint8Array(elevation.length);
  const queue = new Int32Array(elevation.length);
  let head = 0;
  let tail = 0;
  const enqueue = (index: number) => {
    if (elevation[index] > seaLevel || salt[index]) return;
    salt[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (head < tail) {
    const index = queue[head++];
    const x = index % width,
      y = Math.floor(index / width);
    for (const [dx, dy] of dirs) {
      const nx = x + dx,
        ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      enqueue(ny * width + nx);
    }
  }
  for (let index = 0; index < elevation.length; index += 1) {
    if (elevation[index] > seaLevel) result[index] = "land";
    else result[index] = salt[index] ? "saltwater" : "freshwater";
  }
  // 내해형의 가장 큰 내부 수역은 명칭과 지질 설정에 맞게 해수로 취급한다.
  if (settings.mapShape === "inland_sea") {
    const visited = new Uint8Array(elevation.length);
    let largest: number[] = [];
    for (let start = 0; start < elevation.length; start += 1) {
      if (result[start] !== "freshwater" || visited[start]) continue;
      const cells: number[] = [];
      head = 0;
      tail = 0;
      visited[start] = 1;
      queue[tail++] = start;
      while (head < tail) {
        const index = queue[head++];
        cells.push(index);
        const x = index % width,
          y = Math.floor(index / width);
        for (const [dx, dy] of dirs) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (result[next] === "freshwater" && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
      if (cells.length > largest.length) largest = cells;
    }
    for (const index of largest) result[index] = "saltwater";
  }
  return result;
}

/** 육지 존재 여부와 고도를 분리하되, 골자 알고리즘의 상대 기복은 보존한다. */
