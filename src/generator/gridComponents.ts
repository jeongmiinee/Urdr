export type Component = { cells: number[]; size: number };

export function landComponents(
  mask: boolean[],
  width: number,
  height: number,
): Component[] {
  const visited = new Uint8Array(mask.length);
  const components: Component[] = [];
  const queue = new Int32Array(mask.length);
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    const cells: number[] = [];
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const index = queue[head++];
      cells.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      for (const [dx, dy] of directions) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] && !visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
    components.push({ cells, size: cells.length });
  }
  return components.sort((a, b) => b.size - a.size);
}
