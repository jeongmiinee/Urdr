import type { GeneratedRiverGraph, GeneratedRiverSegment } from "../model/world";

export type HydrologyResult = {
  rivers: GeneratedRiverSegment[];
  riverGraph: GeneratedRiverGraph;
  flowAccumulationMap: number[];
  basinMap: number[];
  riverOrderMap: number[];
  riverMagnitudeMap: number[];
  /** 육지 내부에서 끝난 하천이 형성한 담수호 타일. */
  freshwaterLakeMap: number[];
  /** 각 격자가 속한 호수 ID. 호수가 아니면 -1. */
  lakeIdMap: number[];
  /** 호수 ID별 동일 수면 고도. */
  lakeSurfaceElevations: number[];
};
