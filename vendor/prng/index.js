/*
 * From http://www.redblobgames.com/maps/mapgen2/
 * Copyright 2017 Red Blob Games <redblobgames@gmail.com>
 * License: Apache v2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 */
import hashIntModule from 'hash-int';
const hashInt = hashIntModule.default ?? hashIntModule;
export function makeRandInt(seed) {
  let i = 0;
  return function(N) { i++; return hashInt(seed + i) % N; };
}
export function makeRandFloat(seed) {
  const randInt = makeRandInt(seed);
  const divisor = 0x10000000;
  return function() { return randInt(divisor) / divisor; };
}
