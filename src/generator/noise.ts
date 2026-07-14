import { hash2d } from "./random";

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Perlin 보간에 사용하는 5차 fade 곡선. */
function perlinFade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 부호 있는 32비트 정수 혼합. 외부 코드에 의존하지 않는 프로젝트 전용 구현이며,
 * 동일 시드에서 항상 같은 그래디언트 인덱스를 돌려준다.
 */
function integerHash2d(x: number, y: number, seed: number): number {
  let value = Math.imul(x | 0, 0x1f123bb5)
    ^ Math.imul(y | 0, 0x5f356495)
    ^ Math.imul(seed | 0, 0x6c8e9cf5);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

const GRADIENTS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2],
];

function gradientDot(ix: number, iy: number, seed: number, dx: number, dy: number): number {
  const gradient = GRADIENTS[integerHash2d(ix, iy, seed) % GRADIENTS.length];
  return gradient[0] * dx + gradient[1] * dy;
}

export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const a = lerp(hash2d(x0, y0, seed), hash2d(x1, y0, seed), tx);
  const b = lerp(hash2d(x0, y1, seed), hash2d(x1, y1, seed), tx);
  return lerp(a, b, ty);
}

/** 0~1 범위의 결정론적 2차원 그래디언트 노이즈. */
export function perlinNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const sx = perlinFade(tx);
  const sy = perlinFade(ty);
  const n00 = gradientDot(x0, y0, seed, tx, ty);
  const n10 = gradientDot(x0 + 1, y0, seed, tx - 1, ty);
  const n01 = gradientDot(x0, y0 + 1, seed, tx, ty - 1);
  const n11 = gradientDot(x0 + 1, y0 + 1, seed, tx - 1, ty - 1);
  const nx0 = lerp(n00, n10, sx);
  const nx1 = lerp(n01, n11, sx);
  // 8방향 단위 그래디언트의 이론적 범위를 여유 있게 정규화한다.
  return Math.max(0, Math.min(1, lerp(nx0, nx1, sy) * 0.5 + 0.5));
}

export function fractalNoise(
  x: number,
  y: number,
  seed: number,
  octaves = 5,
  persistence = 0.5,
  lacunarity = 2,
): number {
  let amplitude = 1;
  let frequency = 1;
  let value = 0;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    value += valueNoise(x * frequency, y * frequency, seed + octave * 1013) * amplitude;
    total += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return total > 0 ? value / total : 0;
}

export function fractalPerlinNoise(
  x: number,
  y: number,
  seed: number,
  octaves = 5,
  persistence = 0.5,
  lacunarity = 2,
): number {
  let amplitude = 1;
  let frequency = 1;
  let value = 0;
  let total = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    value += perlinNoise(x * frequency, y * frequency, seed + octave * 1013) * amplitude;
    total += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return total > 0 ? value / total : 0;
}
