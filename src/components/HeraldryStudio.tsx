import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createId,
  type HeraldicAsset,
  type HeraldicAssetKind,
  type HeraldicLayer,
  type HeraldicPattern,
  type HeraldicSymbol,
  type Point,
  type WorldProject,
} from "../model/world";
import { sortSelectionOptions } from "../model/selectionSort";
import { useLocalization } from "../localization/LocalizationProvider";

type AssetPatch = Partial<Omit<HeraldicAsset, "id" | "kind" | "createdAt" | "updatedAt">>;
type StudioTab = "shape" | "pattern" | "symbol" | "upload";
type UploadTarget = "pattern" | "symbol" | "composite";

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const now = () => new Date().toISOString();

const flagShapes = [
  { id: "rectangle", label: "직사각형" },
  { id: "rectangle_swallowtail", label: "직사각형(갈라짐)" },
  { id: "square", label: "정사각형" },
  { id: "square_swallowtail", label: "정사각형(갈라짐)" },
  { id: "triangle", label: "삼각형" },
] as const;
const coatShapes = [
  { id: "shield", label: "방패" }, { id: "circle", label: "원형" },
  { id: "square", label: "사각형" }, { id: "triangle", label: "삼각형" },
  { id: "diamond", label: "마름모" },
] as const;

const patterns: ReadonlyArray<{ id: HeraldicPattern; label: string }> = [
  { id: "solid", label: "단색" }, { id: "per_pale", label: "세로 분할" },
  { id: "per_fess", label: "가로 분할" }, { id: "per_bend", label: "우사선 분할" },
  { id: "per_bend_sinister", label: "좌사선 분할" }, { id: "quarterly", label: "사분할" },
  { id: "per_saltire", label: "X자 분할" }, { id: "per_chevron", label: "갈매기형 분할" },
  { id: "per_pall", label: "Y자 분할" }, { id: "gyronny", label: "방사 분할" },
  { id: "barry", label: "가로 반복" }, { id: "paly", label: "세로 반복" },
  { id: "bendy", label: "사선 반복" }, { id: "checkered", label: "체크" },
  { id: "lozengy", label: "마름모 반복" }, { id: "ermine", label: "어민" },
  { id: "vair", label: "베어" }, { id: "chief", label: "치프" },
  { id: "fess", label: "페스" }, { id: "pale", label: "페일" },
  { id: "bend", label: "벤드" }, { id: "bend_sinister", label: "좌벤드" },
  { id: "chevron", label: "셰브론" }, { id: "cross", label: "십자" },
  { id: "saltire", label: "X자 십자" }, { id: "pall", label: "팔" },
  { id: "bordure", label: "테두리" }, { id: "canton", label: "칸톤" },
  { id: "orle", label: "오를" }, { id: "tressure", label: "이중 테두리" },
  { id: "pile", label: "쐐기" }, { id: "flanches", label: "양옆 곡면" },
];

const symbols: ReadonlyArray<{ id: HeraldicSymbol; label: string }> = [
  { id: "circle", label: "동그라미" }, { id: "square", label: "네모" },
  { id: "triangle", label: "세모" }, { id: "star", label: "별" },
  { id: "diamond", label: "마름모" }, { id: "shield", label: "방패" },
  { id: "crown", label: "왕관" }, { id: "heart", label: "하트" },
  { id: "cross", label: "십자가" }, { id: "iron_cross", label: "철십자" },
  { id: "gear", label: "톱니" }, { id: "book", label: "책" },
  { id: "annulet", label: "고리" }, { id: "hollow_square", label: "빈 네모" },
  { id: "hollow_triangle", label: "빈 세모" }, { id: "hollow_star", label: "빈 별" },
  { id: "mascle", label: "빈 마름모" }, { id: "hollow_shield", label: "빈 방패" },
  { id: "crescent_star", label: "초승달과 별" }, { id: "interwoven_knot", label: "엇갈림 매듭" },
];

function layerBase(kind: HeraldicLayer["kind"], name: string, color: string): HeraldicLayer {
  return {
    id: createId("herald-layer"), kind, name, visible: true, locked: false,
    color, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0,
    flipX: false, flipY: false, opacity: 1,
  };
}

export function createDefaultHeraldicAsset(kind: HeraldicAssetKind): HeraldicAsset {
  const createdAt = now();
  return {
    id: createId(kind === "flag" ? "flag-asset" : "coat-asset"), kind,
    name: kind === "flag" ? "새 깃발" : "새 문장", source: "generated",
    shape: kind === "flag" ? "rectangle" : "shield", pattern: "solid", symbol: "none",
    backgroundColor: "#234f8a", patternColor: "#e8d5a1", symbolColor: "#f7f4e8",
    patternScale: 1, symbolScale: 1, symbolOffsetX: 0, symbolOffsetY: 0,
    layers: [], createdAt, updatedAt: createdAt,
  };
}

function legacyLayers(asset: HeraldicAsset): HeraldicLayer[] {
  const result: HeraldicLayer[] = [];
  if (asset.pattern !== "solid" || asset.patternImageDataUrl) {
    result.push({
      ...layerBase(asset.patternImageDataUrl ? "image" : "pattern", "무늬", asset.patternColor),
      pattern: asset.pattern, imageDataUrl: asset.patternImageDataUrl,
      scaleX: asset.patternScale ?? 1, scaleY: asset.patternScale ?? 1,
    });
  }
  if (asset.symbol !== "none" || asset.symbolImageDataUrl) {
    result.push({
      ...layerBase(asset.symbolImageDataUrl ? "image" : "symbol", "문양", asset.symbolColor),
      symbol: asset.symbol, imageDataUrl: asset.symbolImageDataUrl,
      offsetX: asset.symbolOffsetX ?? 0, offsetY: asset.symbolOffsetY ?? 0,
      scaleX: asset.symbolScale ?? 1, scaleY: asset.symbolScale ?? 1,
    });
  }
  if (asset.compositeImageDataUrl) result.push({ ...layerBase("image", "전체 업로드", "#ffffff"), imageDataUrl: asset.compositeImageDataUrl });
  return result;
}

function normalizedAsset(asset: HeraldicAsset): HeraldicAsset {
  const validShapes = asset.kind === "flag" ? flagShapes : coatShapes;
  const legacyShape = String(asset.shape) === "pennant" ? "rectangle_swallowtail" : asset.shape;
  const shape = validShapes.some((entry) => entry.id === legacyShape)
    ? legacyShape : asset.kind === "flag" ? "rectangle" : "shield";
  return {
    ...asset, shape, source: "generated", patternScale: asset.patternScale ?? 1,
    symbolScale: asset.symbolScale ?? 1, symbolOffsetX: asset.symbolOffsetX ?? 0,
    symbolOffsetY: asset.symbolOffsetY ?? 0,
    layers: Array.isArray(asset.layers) && asset.layers.length ? asset.layers.map((layer) => ({
      ...layer, visible: layer.visible !== false, locked: Boolean(layer.locked),
      scaleX: Number.isFinite(layer.scaleX) ? layer.scaleX : 1,
      scaleY: Number.isFinite(layer.scaleY) ? layer.scaleY : 1,
      rotation: Number.isFinite(layer.rotation) ? layer.rotation : 0,
      opacity: Number.isFinite(layer.opacity) ? layer.opacity : 1,
    })) : legacyLayers(asset),
  };
}

function shapePath(asset: HeraldicAsset): string | undefined {
  if (asset.kind === "flag") {
    if (asset.shape === "rectangle_swallowtail") return "M6 18 H94 L78 50 L94 82 H6 Z";
    if (asset.shape === "square_swallowtail") return "M12 10 H88 L70 50 L88 90 H12 Z";
    if (asset.shape === "triangle") return "M8 12 L94 50 L8 88 Z";
    if (asset.shape === "square") return "M12 10 H88 V90 H12 Z";
    return "M6 18 H94 V82 H6 Z";
  }
  if (asset.shape === "shield") return "M18 12 H82 V48 C82 72 65 86 50 94 C35 86 18 72 18 48 Z";
  if (asset.shape === "circle") return undefined;
  if (asset.shape === "triangle") return "M50 8 L92 88 H8 Z";
  if (asset.shape === "diamond") return "M50 7 L93 50 L50 93 L7 50 Z";
  return "M12 12 H88 V88 H12 Z";
}

function HeraldicShape({ asset, fill = "none", stroke = "none", strokeWidth = 0 }: { asset: HeraldicAsset; fill?: string; stroke?: string; strokeWidth?: number }) {
  if (asset.kind === "coatOfArms" && asset.shape === "circle") return <circle cx="50" cy="50" r="40" fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
  return <path d={shapePath(asset)} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />;
}

function PatternLayer({ pattern, color, patternId }: { pattern: HeraldicPattern; color: string; patternId: string }) {
  const repeat = (content: React.ReactNode, width = 24, height = 24) => <><defs><pattern id={patternId} width={width} height={height} patternUnits="userSpaceOnUse">{content}</pattern></defs><rect width="100" height="100" fill={`url(#${patternId})`} /></>;
  if (pattern === "solid") return <rect width="100" height="100" fill={color} />;
  if (pattern === "per_pale") return <rect x="50" width="50" height="100" fill={color} />;
  if (pattern === "per_fess") return <rect y="50" width="100" height="50" fill={color} />;
  if (pattern === "per_bend") return <path d="M0 100 L100 0 H100 V100 Z" fill={color} />;
  if (pattern === "per_bend_sinister") return <path d="M0 0 L100 100 H0 Z" fill={color} />;
  if (pattern === "quarterly") return <path d="M50 0 H100 V50 H50 Z M0 50 H50 V100 H0 Z" fill={color} />;
  if (pattern === "per_saltire") return <path d="M0 0 L50 50 L100 0 Z M0 100 L50 50 L100 100 Z" fill={color} />;
  if (pattern === "per_chevron") return <path d="M0 70 L50 28 L100 70 V100 H0 Z" fill={color} />;
  if (pattern === "per_pall") return <path d="M0 0 L50 50 L100 0 V100 H0 Z" fill={color} />;
  if (pattern === "gyronny") return <path d="M50 50 L0 0 H50 Z M50 50 L100 0 V50 Z M50 50 L100 100 H50 Z M50 50 L0 100 V50 Z" fill={color} />;
  if (pattern === "barry") return repeat(<rect width="24" height="12" fill={color} />, 24, 24);
  if (pattern === "paly") return repeat(<rect width="12" height="24" fill={color} />, 24, 24);
  if (pattern === "bendy" || pattern === "stripes") return repeat(<path d="M-8 24 L24 -8 M4 36 L36 4" stroke={color} strokeWidth="9" />, 24, 24);
  if (pattern === "checkered") return repeat(<><rect width="14" height="14" fill={color} /><rect x="14" y="14" width="14" height="14" fill={color} /></>, 28, 28);
  if (pattern === "grid") return repeat(<path d="M0 0 H24 M0 0 V24" stroke={color} strokeWidth="5" />, 24, 24);
  if (pattern === "lozengy") return repeat(<path d="M12 1 L23 12 L12 23 L1 12 Z" fill={color} />, 24, 24);
  if (pattern === "ermine") return repeat(<path d="M10 4 C7 10 7 14 10 19 C13 14 13 10 10 4 Z M4 18 L10 13 L16 18" fill={color} />, 20, 22);
  if (pattern === "vair") return repeat(<path d="M0 0 H12 C12 8 18 8 18 16 H6 C6 8 0 8 0 0 Z" fill={color} />, 18, 16);
  if (pattern === "chief") return <rect width="100" height="28" fill={color} />;
  if (pattern === "fess") return <rect y="39" width="100" height="22" fill={color} />;
  if (pattern === "pale") return <rect x="39" width="22" height="100" fill={color} />;
  if (pattern === "bend") return <path d="M-10 82 L82 -10 L110 18 L18 110 Z" fill={color} />;
  if (pattern === "bend_sinister") return <path d="M-10 18 L18 -10 L110 82 L82 110 Z" fill={color} />;
  if (pattern === "chevron") return <path d="M0 68 L50 25 L100 68 L88 82 L50 49 L12 82 Z" fill={color} />;
  if (pattern === "cross") return <path d="M39 0 H61 V39 H100 V61 H61 V100 H39 V61 H0 V39 H39 Z" fill={color} />;
  if (pattern === "saltire") return <path d="M0 0 L50 37 L100 0 L100 18 L63 50 L100 82 L100 100 L50 63 L0 100 L0 82 L37 50 L0 18 Z" fill={color} />;
  if (pattern === "pall") return <path d="M39 100 V52 L0 20 V0 L50 39 L100 0 V20 L61 52 V100 Z" fill={color} />;
  if (pattern === "bordure") return <path d="M8 8 H92 V92 H8 Z M18 18 V82 H82 V18 Z" fill={color} fillRule="evenodd" />;
  if (pattern === "canton") return <rect x="10" y="10" width="36" height="36" fill={color} />;
  if (pattern === "orle") return <rect x="17" y="17" width="66" height="66" rx="12" fill="none" stroke={color} strokeWidth="7" />;
  if (pattern === "tressure") return <><rect x="14" y="14" width="72" height="72" rx="12" fill="none" stroke={color} strokeWidth="4" /><rect x="21" y="21" width="58" height="58" rx="9" fill="none" stroke={color} strokeWidth="3" /></>;
  if (pattern === "pile") return <path d="M25 0 H75 L50 88 Z" fill={color} />;
  return <path d="M0 0 C35 20 35 80 0 100 Z M100 0 C65 20 65 80 100 100 Z" fill={color} />;
}

function SymbolShape({ symbol, color }: { symbol: HeraldicSymbol; color: string }) {
  if (symbol === "none") return null;
  if (symbol === "roundel" || symbol === "circle") return <circle cx="50" cy="50" r="22" fill={color} />;
  if (symbol === "square") return <rect x="28" y="28" width="44" height="44" fill={color} />;
  if (symbol === "triangle") return <path d="M50 22 L78 76 H22 Z" fill={color} />;
  if (symbol === "lozenge" || symbol === "diamond") return <path d="M50 22 L72 50 L50 78 L28 50 Z" fill={color} />;
  if (symbol === "mascle") return <path d="M50 18 L78 50 L50 82 L22 50 Z M50 33 L36 50 L50 67 L64 50 Z" fill={color} fillRule="evenodd" />;
  if (symbol === "annulet") return <circle cx="50" cy="50" r="24" fill="none" stroke={color} strokeWidth="9" />;
  if (symbol === "star") return <path d="M50 18 L59 40 L82 41 L64 56 L70 80 L50 67 L30 80 L36 56 L18 41 L41 40 Z" fill={color} />;
  if (symbol === "hollow_square") return <rect x="25" y="25" width="50" height="50" fill="none" stroke={color} strokeWidth="8" />;
  if (symbol === "hollow_triangle") return <path d="M50 20 L80 78 H20 Z" fill="none" stroke={color} strokeWidth="8" strokeLinejoin="round" />;
  if (symbol === "hollow_star") return <path d="M50 18 L59 40 L82 41 L64 56 L70 80 L50 67 L30 80 L36 56 L18 41 L41 40 Z" fill="none" stroke={color} strokeWidth="7" strokeLinejoin="round" />;
  if (symbol === "hollow_shield") return <path d="M27 25 H73 V52 C73 68 62 78 50 84 C38 78 27 68 27 52 Z" fill="none" stroke={color} strokeWidth="8" strokeLinejoin="round" />;
  if (symbol === "sun") return <g fill={color}><circle cx="50" cy="50" r="17" /><path d="M47 15 H53 V31 H47 Z M47 69 H53 V85 H47 Z M15 47 H31 V53 H15 Z M69 47 H85 V53 H69 Z M24 20 L35 32 L31 36 L20 24 Z M65 68 L76 80 L80 76 L69 64 Z M76 20 L65 32 L69 36 L80 24 Z M35 68 L24 80 L20 76 L31 64 Z" /></g>;
  if (symbol === "crescent") return <path d="M59 22 A30 30 0 1 0 59 78 A24 24 0 1 1 59 22 Z" fill={color} />;
  if (symbol === "crescent_star") return <g fill={color}><path d="M50 22 A28 28 0 1 0 50 78 A22 22 0 1 1 50 22 Z" /><path d="M70 34 L74 44 L85 44 L76 51 L79 62 L70 56 L61 62 L64 51 L55 44 L66 44 Z" /></g>;
  if (symbol === "cross") return <path d="M43 20 H57 V43 H80 V57 H57 V80 H43 V57 H20 V43 H43 Z" fill={color} />;
  if (symbol === "iron_cross") return <path d="M38 18 H62 L60 38 L82 36 V64 L60 62 L62 82 H38 L40 62 L18 64 V36 L40 38 Z" fill={color} />;
  if (symbol === "crown") return <path d="M22 66 L18 31 L38 47 L50 22 L62 47 L82 31 L78 66 Z M23 71 H77 V78 H23 Z" fill={color} />;
  if (symbol === "heart") return <path d="M50 79 C40 66 22 58 22 41 C22 27 39 23 50 37 C61 23 78 27 78 41 C78 58 60 66 50 79 Z" fill={color} />;
  if (symbol === "fleur_de_lis") return <path d="M50 18 C63 31 65 40 55 49 L66 45 C75 43 81 49 78 59 C68 55 61 57 56 63 L60 72 H40 L44 63 C39 57 32 55 22 59 C19 49 25 43 34 45 L45 49 C35 40 37 31 50 18 Z" fill={color} />;
  if (["rose", "oak_leaf", "acorn", "tree", "wheat", "palm"].includes(symbol)) {
    if (symbol === "tree") return <path d="M46 78 V60 H37 L43 51 H34 L43 41 H37 L50 20 L63 41 H57 L66 51 H57 L63 60 H54 V78 Z" fill={color} />;
    if (symbol === "wheat") return <path d="M48 82 H54 V24 H48 Z M48 34 C35 25 32 35 48 43 Z M54 43 C70 34 67 25 54 34 Z M48 50 C34 41 31 52 48 59 Z M54 59 C71 52 68 41 54 50 Z M48 66 C36 58 34 68 48 74 Z M54 74 C68 68 66 58 54 66 Z" fill={color} />;
    if (symbol === "acorn") return <path d="M37 37 Q50 25 63 37 L59 45 H41 Z M40 46 C37 66 44 78 50 82 C56 78 63 66 60 46 Z M49 31 Q58 18 67 25" fill={color} stroke={color} strokeWidth="4" />;
    if (symbol === "oak_leaf") return <path d="M48 80 C52 66 50 59 45 54 C30 58 27 46 38 42 C26 34 35 24 44 32 C45 20 57 20 57 34 C69 29 75 40 64 47 C73 56 63 65 55 58 C55 67 53 75 52 82 Z" fill={color} />;
    return <path d="M50 22 C60 32 74 30 72 44 C83 50 74 61 62 58 C61 72 48 76 42 63 C30 70 20 58 30 49 C19 38 33 28 44 35 C43 29 46 24 50 22 Z" fill={color} />;
  }
  if (["sword", "spear", "axe", "hammer", "bow", "shield", "helm", "key", "torch"].includes(symbol)) {
    if (symbol === "shield") return <path d="M27 25 H73 V52 C73 68 62 78 50 84 C38 78 27 68 27 52 Z" fill={color} />;
    if (symbol === "helm") return <path d="M28 64 V45 C28 28 42 20 55 23 C69 26 75 38 72 55 H54 V72 H42 V60 H28 Z M53 38 H72 V45 H53 Z" fill={color} />;
    if (symbol === "bow") return <path d="M30 20 C66 34 66 66 30 80 M30 20 L45 50 L30 80" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" />;
    if (symbol === "axe") return <path d="M47 30 H55 V82 H47 Z M51 29 C34 16 25 31 29 47 C38 39 45 39 51 43 Z" fill={color} />;
    if (symbol === "hammer") return <path d="M46 39 H54 V82 H46 Z M27 22 H69 L76 35 H27 Z" fill={color} />;
    if (symbol === "key") return <path d="M50 20 A17 17 0 1 0 50 54 H55 V82 H63 V73 H72 V65 H63 V50 A17 17 0 0 0 50 20 Z M50 29 A8 8 0 1 1 50 45 A8 8 0 0 1 50 29 Z" fill={color} fillRule="evenodd" />;
    if (symbol === "torch") return <path d="M43 43 H57 L54 80 H46 Z M50 42 C32 34 45 21 50 16 C55 25 69 31 50 42 Z" fill={color} />;
    return <path d="M47 78 H53 V37 L62 46 L50 18 L38 46 L47 37 Z M36 52 H64 V58 H36 Z" fill={color} />;
  }
  if (["castle", "tower", "bridge", "ship", "anchor", "book", "scales", "gear", "fortress_wall"].includes(symbol)) {
    if (symbol === "tower" || symbol === "castle" || symbol === "fortress_wall") return <path d="M22 76 V38 H31 V29 H41 V38 H59 V29 H69 V38 H78 V76 Z M42 76 V58 H58 V76 Z" fill={color} fillRule="evenodd" />;
    if (symbol === "bridge") return <path d="M15 63 H85 V75 H15 Z M22 63 C22 38 42 38 42 63 H51 C51 38 71 38 71 63 Z" fill={color} fillRule="evenodd" />;
    if (symbol === "ship") return <path d="M18 62 H82 C75 77 62 82 49 82 C34 82 23 75 18 62 Z M47 20 H53 V60 H47 Z M54 25 L76 54 H54 Z M46 31 L27 54 H46 Z" fill={color} />;
    if (symbol === "anchor") return <path d="M46 18 H54 V34 A10 10 0 1 0 46 34 Z M46 43 H54 V72 C65 71 72 65 76 55 L84 61 C76 78 65 84 50 84 C35 84 24 78 16 61 L24 55 C28 65 35 71 46 72 Z" fill={color} />;
    if (symbol === "book") return <path d="M18 27 C32 23 42 26 50 34 C58 26 68 23 82 27 V73 C68 69 58 72 50 80 C42 72 32 69 18 73 Z M47 35 V74 H53 V35 Z" fill={color} fillRule="evenodd" />;
    if (symbol === "scales") return <path d="M47 20 H53 V72 H67 V79 H33 V72 H47 Z M22 35 H78 V41 H22 Z M30 40 L18 61 H42 Z M70 40 L58 61 H82 Z" fill={color} />;
    return <path d="M50 17 L57 27 L69 23 L71 36 L83 42 L76 53 L83 64 L71 70 L69 83 L57 79 L50 89 L43 79 L31 83 L29 70 L17 64 L24 53 L17 42 L29 36 L31 23 L43 27 Z M50 38 A15 15 0 1 0 50 68 A15 15 0 0 0 50 38 Z" fill={color} fillRule="evenodd" />;
  }
  if (["eagle", "raven", "fish", "serpent", "dragon", "griffin"].includes(symbol)) {
    if (symbol === "fish") return <path d="M19 50 C35 30 61 29 75 46 L88 34 V66 L75 54 C61 71 35 70 19 50 Z M36 45 A3 3 0 1 0 36 51 A3 3 0 0 0 36 45 Z" fill={color} fillRule="evenodd" />;
    if (symbol === "serpent") return <path d="M27 70 C68 86 71 55 42 55 C13 55 21 22 58 26 C71 27 77 35 74 44" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" />;
    return <path d="M50 42 C35 22 18 24 13 31 C24 35 29 44 31 56 L18 65 C31 68 42 63 50 54 C58 63 69 68 82 65 L69 56 C71 44 76 35 87 31 C82 24 65 22 50 42 Z M45 53 H55 V80 H45 Z" fill={color} />;
  }
  if (["lion", "horse", "stag", "boar", "wolf", "bear", "unicorn"].includes(symbol)) return <path d="M23 58 C25 39 38 30 57 34 L69 26 L78 30 L72 40 C82 48 79 61 69 64 L66 80 H58 L57 65 H41 L38 80 H30 L31 63 C25 64 20 62 18 57 Z M28 43 L20 31 L30 35 Z" fill={color} />;
  if (symbol === "interwoven_knot") return <g fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"><path d="M28 50 C28 31 41 22 50 31 C59 22 72 31 72 50 C72 69 59 78 50 69 C41 78 28 69 28 50 Z" /><path d="M50 28 C69 28 78 41 69 50 C78 59 69 72 50 72 C31 72 22 59 31 50 C22 41 31 28 50 28 Z" /></g>;
  return <path d="M50 22 L72 38 L68 68 L50 80 L32 68 L28 38 Z" fill={color} />;
}

function layerTransform(layer: HeraldicLayer): string {
  const sx = clamp(layer.scaleX, .15, 4) * (layer.flipX ? -1 : 1);
  const sy = clamp(layer.scaleY, .15, 4) * (layer.flipY ? -1 : 1);
  return `translate(${layer.offsetX * 34} ${layer.offsetY * 34}) translate(50 50) rotate(${layer.rotation}) scale(${sx} ${sy}) translate(-50 -50)`;
}

export function HeraldicPreview({ asset, className = "", interactive = false, selectedLayerId, onLayerOffsetChange, onSymbolOffsetChange }: {
  asset?: HeraldicAsset; className?: string; interactive?: boolean; selectedLayerId?: string;
  onLayerOffsetChange?: (layerId: string, x: number, y: number) => void;
  onSymbolOffsetChange?: (x: number, y: number) => void;
}) {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!asset) return <div className={`heraldry-placeholder ${className}`}>미설정</div>;
  const value = normalizedAsset(asset);
  const clipId = `heraldry-clip-${instanceId}`;
  const activeLayer = value.layers?.find((layer) => layer.id === selectedLayerId && layer.visible && !layer.locked);
  const pointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!interactive || !activeLayer) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp((((event.clientX - rect.left) / Math.max(1, rect.width)) * 100 - 50) / 34, -1.4, 1.4);
    const y = clamp((((event.clientY - rect.top) / Math.max(1, rect.height)) * 100 - 50) / 34, -1.4, 1.4);
    onLayerOffsetChange?.(activeLayer.id, x, y);
    if (activeLayer.kind === "symbol") onSymbolOffsetChange?.(x, y);
  };
  return <svg className={`heraldry-preview-svg ${interactive ? "interactive" : ""} ${className}`} viewBox="0 0 100 100" role="img" aria-label={value.name}
    onPointerDown={(event) => { if (activeLayer) { event.currentTarget.setPointerCapture(event.pointerId); pointer(event); } }}
    onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) pointer(event); }}>
    <defs><clipPath id={clipId}><HeraldicShape asset={value} fill="#fff" /></clipPath></defs>
    <g clipPath={`url(#${clipId})`}><rect width="100" height="100" fill={value.backgroundColor} />
      {(value.layers ?? []).filter((layer) => layer.visible).map((layer, index) => <g key={layer.id} transform={layerTransform(layer)} opacity={clamp(layer.opacity, 0, 1)}>
        {layer.kind === "pattern" && <PatternLayer pattern={layer.pattern ?? "solid"} color={layer.color} patternId={`${clipId}-pattern-${index}`} />}
        {layer.kind === "symbol" && <SymbolShape symbol={layer.symbol ?? "none"} color={layer.color} />}
        {layer.kind === "image" && layer.imageDataUrl && <image href={layer.imageDataUrl} width="100" height="100" preserveAspectRatio="xMidYMid meet" />}
      </g>)}
    </g><HeraldicShape asset={value} stroke="currentColor" strokeWidth={3} />
  </svg>;
}

function TerritoryPreview({ polygons, color }: { polygons: Point[][]; color: string }) {
  const bounds = useMemo(() => { const all = polygons.flat(); if (!all.length) return null; const xs = all.map((point) => point.x); const ys = all.map((point) => point.y); return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }; }, [polygons]);
  if (!bounds) return null;
  const width = Math.max(1, bounds.maxX - bounds.minX); const height = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(260 / width, 130 / height); const ox = (280 - width * scale) / 2; const oy = (150 - height * scale) / 2;
  const points = (polygon: Point[]) => polygon.map((point) => `${ox + (point.x - bounds.minX) * scale},${oy + (point.y - bounds.minY) * scale}`).join(" ");
  return <div className="territory-document-preview"><span>현재 영토</span><svg viewBox="0 0 280 150" aria-label="현재 영토 모습">{polygons.map((polygon, index) => <polygon key={index} points={points(polygon)} fill={color} stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}</svg></div>;
}

export function HeraldryDisplay({ project, flagAssetId, coatAssetId, showFlag, showCoat, territoryPolygons = [], territoryColor = "#5f8fb3" }: { project: WorldProject; flagAssetId?: string; coatAssetId?: string; showFlag?: boolean; showCoat?: boolean; territoryPolygons?: Point[][]; territoryColor?: string }) {
  const flag = project.heraldicAssets.find((asset) => asset.id === flagAssetId && asset.kind === "flag");
  const coat = project.heraldicAssets.find((asset) => asset.id === coatAssetId && asset.kind === "coatOfArms");
  if (!territoryPolygons.length && !showFlag && !showCoat) return null;
  return <section className="heraldry-document-display">{territoryPolygons.length > 0 && <TerritoryPreview polygons={territoryPolygons} color={territoryColor} />} {(showFlag || showCoat) && <div className="heraldry-pair">{showFlag && <div><span>깃발</span><HeraldicPreview asset={flag} /></div>}{showCoat && <div><span>문장</span><HeraldicPreview asset={coat} /></div>}</div>}</section>;
}

type HeraldryStudioProps = {
  project: WorldProject; kind: HeraldicAssetKind; onChange: (project: WorldProject) => void;
  onClose: () => void; onSelect?: (assetId: string) => void;
  onSave?: (project: WorldProject, assetId: string) => void; startNew?: boolean;
  initialAssetId?: string; embedded?: boolean;
};

function colorFamily(hex: string): "metal" | "color" {
  const raw = hex.replace("#", "");
  const rgb = raw.length === 6 ? [0, 2, 4].map((index) => Number.parseInt(raw.slice(index, index + 2), 16) / 255) : [0, 0, 0];
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .68 ? "metal" : "color";
}

export function HeraldryStudioModal({ project, kind, onChange, onClose, onSelect, onSave, startNew = false, initialAssetId, embedded = false }: HeraldryStudioProps) {
  const { t } = useLocalization();
  const existing = project.heraldicAssets.filter((asset) => asset.kind === kind).map(normalizedAsset);
  const initial = normalizedAsset((!startNew && initialAssetId ? existing.find((asset) => asset.id === initialAssetId) : undefined) ?? (!startNew ? existing[0] : undefined) ?? createDefaultHeraldicAsset(kind));
  const [draft, setDraft] = useState<HeraldicAsset>({ ...initial, layers: [...(initial.layers ?? [])] });
  const [activeTab, setActiveTab] = useState<StudioTab>("shape");
  const [selectedLayerId, setSelectedLayerId] = useState<string | undefined>(initial.layers?.at(-1)?.id);
  const [uploadTarget, setUploadTarget] = useState<UploadTarget>("symbol");
  const [angleSnap, setAngleSnap] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const contextRef = useRef(`${kind}:${startNew}:${initialAssetId ?? ""}`);
  const shapes = kind === "flag" ? flagShapes : coatShapes;
  const selectedLayer = draft.layers?.find((layer) => layer.id === selectedLayerId);

  useEffect(() => {
    const context = `${kind}:${startNew}:${initialAssetId ?? ""}`;
    if (contextRef.current === context) return;
    contextRef.current = context;
    setDraft({ ...initial, layers: [...(initial.layers ?? [])] });
    setSelectedLayerId(initial.layers?.at(-1)?.id);
    setActiveTab("shape");
  }, [kind, startNew, initialAssetId, initial]);

  const patch = (value: AssetPatch) => setDraft((current) => ({ ...current, ...value, source: "generated", updatedAt: now() }));
  const replaceLayers = (layers: HeraldicLayer[]) => patch({ layers });
  const updateLayer = (id: string, value: Partial<HeraldicLayer>) => replaceLayers((draft.layers ?? []).map((layer) => layer.id === id ? { ...layer, ...value } : layer));
  const addLayer = (layer: HeraldicLayer) => { replaceLayers([...(draft.layers ?? []), layer]); setSelectedLayerId(layer.id); };
  const choosePattern = (pattern: HeraldicPattern) => {
    if (pattern === "solid") { replaceLayers((draft.layers ?? []).filter((layer) => layer.kind !== "pattern")); patch({ pattern }); return; }
    if (selectedLayer?.kind === "pattern") updateLayer(selectedLayer.id, { pattern, name: patterns.find((entry) => entry.id === pattern)?.label ?? "무늬" });
    else addLayer({ ...layerBase("pattern", patterns.find((entry) => entry.id === pattern)?.label ?? "무늬", draft.patternColor), pattern });
    patch({ pattern });
  };
  const chooseSymbol = (symbol: HeraldicSymbol) => {
    if (symbol === "none") return;
    if (selectedLayer?.kind === "symbol") updateLayer(selectedLayer.id, { symbol, name: symbols.find((entry) => entry.id === symbol)?.label ?? "문양" });
    else addLayer({ ...layerBase("symbol", symbols.find((entry) => entry.id === symbol)?.label ?? "문양", draft.symbolColor), symbol });
    patch({ symbol });
  };
  const moveLayer = (id: string, direction: -1 | 1) => {
    const layers = [...(draft.layers ?? [])]; const index = layers.findIndex((layer) => layer.id === id);
    const target = clamp(index + direction, 0, layers.length - 1); if (index < 0 || target === index) return;
    [layers[index], layers[target]] = [layers[target], layers[index]]; replaceLayers(layers);
  };
  const duplicateLayer = (layer: HeraldicLayer) => addLayer({ ...layer, id: createId("herald-layer"), name: `${layer.name} 복제`, offsetX: clamp(layer.offsetX + .08, -1.4, 1.4), offsetY: clamp(layer.offsetY + .08, -1.4, 1.4) });
  const deleteLayer = (id: string) => { const layers = (draft.layers ?? []).filter((layer) => layer.id !== id); replaceLayers(layers); setSelectedLayerId(layers.at(-1)?.id); };
  const save = () => {
    const saved = normalizedAsset({ ...draft, source: "generated", imageDataUrl: undefined });
    const exists = project.heraldicAssets.some((asset) => asset.id === saved.id);
    const nextProject = { ...project, heraldicAssets: exists ? project.heraldicAssets.map((asset) => asset.id === saved.id ? saved : asset) : [...project.heraldicAssets, saved] };
    if (onSave) onSave(nextProject, saved.id); else { onChange(nextProject); onSelect?.(saved.id); }
  };
  const upload = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const imageDataUrl = String(reader.result ?? "");
      const layer = { ...layerBase("image", uploadTarget === "pattern" ? "업로드 무늬" : uploadTarget === "symbol" ? "업로드 문양" : "업로드 전체", "#ffffff"), imageDataUrl, ...(uploadTarget === "symbol" ? { scaleX: .55, scaleY: .55 } : {}) };
      const kept = uploadTarget === "composite" ? [] : (draft.layers ?? []);
      patch({ layers: [...kept, layer] }); setSelectedLayerId(layer.id);
    };
    reader.readAsDataURL(file);
  };
  const previewAsset = (shape?: HeraldicAsset["shape"], pattern?: HeraldicPattern, symbol?: HeraldicSymbol): HeraldicAsset => ({
    ...draft, id: createId("preview"), shape: shape ?? draft.shape,
    layers: pattern ? [{ ...layerBase("pattern", "미리보기", draft.patternColor), pattern }]
      : symbol ? [{ ...layerBase("symbol", "미리보기", draft.symbolColor), symbol }]
        : draft.layers,
  });
  const layerThumbnailAsset = (layer: HeraldicLayer): HeraldicAsset => ({
    ...draft,
    id: `${draft.id}-layer-thumbnail-${layer.id}`,
    layers: [{ ...layer, visible: true }],
  });
  const warning = (draft.layers ?? []).some((layer) => layer.visible && colorFamily(layer.color) === colorFamily(draft.backgroundColor));

  const studio = <section className={`heraldry-studio heraldry-layer-studio ${embedded ? "embedded" : ""}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true}>
    <header><div><h2>{kind === "flag" ? t("workspace.flags") : t("workspace.emblems")}</h2></div><button type="button" aria-label="생성기 닫기" onClick={onClose}>×</button></header>
    <div className="heraldry-studio-grid">
      <aside className="heraldry-asset-rail"><button type="button" className="primary-button full" onClick={() => { const asset = createDefaultHeraldicAsset(kind); setDraft(asset); setSelectedLayerId(undefined); }}>＋ 새 자산</button>{sortSelectionOptions(existing.map((asset) => ({ id: asset.id, label: asset.name, asset }))).map(({ asset }) => <button type="button" className={asset.id === draft.id ? "active" : ""} key={asset.id} onClick={() => { setDraft({ ...asset, layers: [...(asset.layers ?? [])] }); setSelectedLayerId(asset.layers?.at(-1)?.id); }}><HeraldicPreview asset={asset} /><span title={asset.name}>{asset.name}</span></button>)}</aside>
      <main>
        <div className="heraldry-composer">
          <aside className="heraldry-layer-rail" aria-label="레이어 목록"><div className="heraldry-layer-list">{[...(draft.layers ?? [])].reverse().map((layer) => <button type="button" key={layer.id} aria-label={layer.name} title={layer.name} className={`heraldry-layer-thumbnail-button${layer.id === selectedLayerId ? " active" : ""}${layer.visible ? "" : " hidden-layer"}`} onClick={() => setSelectedLayerId(layer.id)}><span className="heraldry-layer-thumbnail" aria-hidden="true"><HeraldicPreview asset={layerThumbnailAsset(layer)} /></span><span className="heraldry-layer-thumbnail-status" aria-hidden="true">{!layer.visible && <span className="mdl2-icon hide" />}{layer.locked && <span className="mdl2-icon lock" />}</span></button>)}{!draft.layers?.length && <p className="empty-hint">무늬나 문양을 추가하세요.</p>}</div></aside>
          <div className="heraldry-center-workspace">
            <div className="heraldry-live-preview"><HeraldicPreview asset={draft} interactive selectedLayerId={selectedLayerId} onLayerOffsetChange={(id, x, y) => updateLayer(id, { offsetX: x, offsetY: y })} /><small>{selectedLayer && !selectedLayer.locked ? "선택 레이어를 끌어 위치를 조정할 수 있습니다." : "레이어를 선택해 편집하세요."}</small></div>
            <div className="heraldry-name-format-row"><label>이름<input value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>{warning && <span className="heraldry-tincture-warning">배경과 레이어의 명도 계열이 비슷합니다. 식별성을 확인하세요.</span>}</div>
            <div className="heraldry-tab-workspace">
              <nav className="heraldry-browser-tabs" aria-label="깃발과 문장 구성"><button type="button" className={activeTab === "shape" ? "active" : ""} onClick={() => setActiveTab("shape")}>모양</button><button type="button" className={activeTab === "pattern" ? "active" : ""} onClick={() => setActiveTab("pattern")}>무늬</button><button type="button" className={activeTab === "symbol" ? "active" : ""} onClick={() => setActiveTab("symbol")}>문양</button><button type="button" className={activeTab === "upload" ? "active" : ""} onClick={() => setActiveTab("upload")}>사진</button></nav>
              {activeTab === "shape" && <section className="heraldry-tab-panel"><label className="heraldry-tab-color">바탕색<input type="color" value={draft.backgroundColor} onChange={(event) => patch({ backgroundColor: event.target.value })} /></label><div className="heraldry-option-grid">{shapes.map((entry) => <button type="button" key={entry.id} className={draft.shape === entry.id ? "active" : ""} onClick={() => patch({ shape: entry.id })}><HeraldicPreview asset={previewAsset(entry.id)} /><span>{entry.label}</span></button>)}</div></section>}
              {activeTab === "pattern" && <section className="heraldry-tab-panel"><div className="heraldry-tab-color"><span>무늬 레이어</span><button type="button" className="secondary-button" onClick={() => { const layer = { ...layerBase("pattern", "새 무늬", draft.patternColor), pattern: "fess" as HeraldicPattern }; addLayer(layer); }}>＋ 추가</button></div><div className="heraldry-option-grid heraldry-dense-options">{patterns.map((entry) => <button type="button" key={entry.id} className={selectedLayer?.kind === "pattern" && selectedLayer.pattern === entry.id ? "active" : ""} onClick={() => choosePattern(entry.id)}><HeraldicPreview asset={previewAsset(undefined, entry.id)} /><span>{entry.label}</span></button>)}</div></section>}
              {activeTab === "symbol" && <section className="heraldry-tab-panel"><div className="heraldry-tab-color"><span>문양 레이어</span><button type="button" className="secondary-button" onClick={() => chooseSymbol("star")}>＋ 추가</button></div><div className="heraldry-option-grid heraldry-dense-options">{symbols.map((entry) => <button type="button" key={entry.id} className={selectedLayer?.kind === "symbol" && selectedLayer.symbol === entry.id ? "active" : ""} onClick={() => chooseSymbol(entry.id)}><HeraldicPreview asset={previewAsset(undefined, undefined, entry.id)} /><span>{entry.label}</span></button>)}</div></section>}
              {activeTab === "upload" && <section className="heraldry-tab-panel heraldry-upload-panel"><div className="heraldry-upload-targets" role="group" aria-label="사진 적용 대상"><button type="button" className={uploadTarget === "pattern" ? "active" : ""} onClick={() => setUploadTarget("pattern")}>무늬 대체</button><button type="button" className={uploadTarget === "symbol" ? "active" : ""} onClick={() => setUploadTarget("symbol")}>문양 대체</button><button type="button" className={uploadTarget === "composite" ? "active" : ""} onClick={() => setUploadTarget("composite")}>무늬·문양 대체</button></div><input ref={fileRef} hidden type="file" accept="image/*" onChange={(event) => { upload(event.target.files?.[0]); event.currentTarget.value = ""; }} /><button type="button" className="primary-button" onClick={() => fileRef.current?.click()}>사진 선택</button><small>사진은 현재 외곽 안에 클리핑되며 독립 레이어로 편집됩니다.</small></section>}
            </div>
            <footer><button type="button" className="secondary-button" onClick={onClose}>취소</button><button type="button" className="primary-button" onClick={save}>저장{onSelect ? " 및 사용" : ""}</button></footer>
          </div>
          <aside className="heraldry-layer-inspector" aria-label="선택 레이어 편집">{selectedLayer ? <section className="heraldry-layer-controls"><h3 title={selectedLayer.name}>{selectedLayer.name}</h3><div className="heraldry-layer-toolbar"><button type="button" aria-label="보이기 전환" title="보이기 전환" onClick={() => updateLayer(selectedLayer.id, { visible: !selectedLayer.visible })}><span className={`mdl2-icon ${selectedLayer.visible ? "view" : "hide"}`} aria-hidden="true" /></button><button type="button" aria-label="잠금 전환" title="잠금 전환" onClick={() => updateLayer(selectedLayer.id, { locked: !selectedLayer.locked })}><span className={`mdl2-icon ${selectedLayer.locked ? "unlock" : "lock"}`} aria-hidden="true" /></button><button type="button" aria-label="위로 올리기" title="위로 올리기" onClick={() => moveLayer(selectedLayer.id, 1)}>↑</button><button type="button" aria-label="아래로 내리기" title="아래로 내리기" onClick={() => moveLayer(selectedLayer.id, -1)}>↓</button><button type="button" aria-label="복제하기" title="복제하기" onClick={() => duplicateLayer(selectedLayer)}>⧉</button><button type="button" className="danger-ghost" aria-label="삭제" title="삭제" onClick={() => deleteLayer(selectedLayer.id)}>×</button></div><div className="heraldry-transform-grid"><label>색상<input type="color" value={selectedLayer.color} disabled={selectedLayer.kind === "image" || selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { color: event.target.value })} /></label><label>크기<input type="range" min="20" max="300" value={Math.round(selectedLayer.scaleX * 100)} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { scaleX: Number(event.target.value) / 100, scaleY: Number(event.target.value) / 100 })} /></label><label>불투명도<input type="range" min="0" max="100" value={Math.round(selectedLayer.opacity * 100)} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { opacity: Number(event.target.value) / 100 })} /></label><label>X<input type="number" min="-1.4" max="1.4" step=".05" value={selectedLayer.offsetX} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { offsetX: clamp(Number(event.target.value), -1.4, 1.4) })} /></label><label>Y<input type="number" min="-1.4" max="1.4" step=".05" value={selectedLayer.offsetY} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { offsetY: clamp(Number(event.target.value), -1.4, 1.4) })} /></label><label>각도<input type="number" min="-180" max="180" step={angleSnap ? 15 : 1} value={selectedLayer.rotation} disabled={selectedLayer.locked} onChange={(event) => { const raw = Number(event.target.value); updateLayer(selectedLayer.id, { rotation: angleSnap ? Math.round(raw / 15) * 15 : raw }); }} /></label></div><div className="heraldry-transform-toggles"><label><input type="checkbox" checked={angleSnap} onChange={(event) => setAngleSnap(event.target.checked)} /> 15도 스냅</label><label><input type="checkbox" checked={selectedLayer.flipX} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { flipX: event.target.checked })} /> 좌우 반전</label><label><input type="checkbox" checked={selectedLayer.flipY} disabled={selectedLayer.locked} onChange={(event) => updateLayer(selectedLayer.id, { flipY: event.target.checked })} /> 상하 반전</label></div></section> : <p className="empty-hint">편집할 레이어를 선택하세요.</p>}</aside>
        </div>
      </main>
    </div>
  </section>;
  if (embedded) return studio;
  return createPortal(<div className="modal-backdrop heraldry-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{studio}</div>, document.body);
}

type HeraldryEditorPatch = { displayFlag?: boolean; displayCoatOfArms?: boolean; flagAssetId?: string; coatOfArmsAssetId?: string };

export function HeraldryEditorFields({ project, displayFlag, displayCoat, flagAssetId, coatAssetId, onChange }: { project: WorldProject; displayFlag?: boolean; displayCoat?: boolean; flagAssetId?: string; coatAssetId?: string; onChange: (patch: HeraldryEditorPatch) => void }) {
  const assetsFor = (kind: HeraldicAssetKind) => sortSelectionOptions(project.heraldicAssets.filter((asset) => asset.kind === kind).map((asset) => ({ id: asset.id, label: asset.name, asset })));
  const block = (kind: HeraldicAssetKind, enabled: boolean, selectedId?: string) => {
    if (!enabled) return null;
    const assets = assetsFor(kind); const asset = assets.find((entry) => entry.id === selectedId)?.asset;
    const idKey = kind === "flag" ? "flagAssetId" : "coatOfArmsAssetId";
    return <div className="heraldry-inline-editor"><HeraldicPreview asset={asset} /><label className="heraldry-asset-selector">{kind === "flag" ? "깃발 자산" : "문장 자산"}<select value={selectedId ?? ""} onChange={(event) => onChange({ [idKey]: event.target.value || undefined })}><option value="">미지정</option>{assets.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label></div>;
  };
  return <section className="heraldry-editor-fields"><h4>깃발과 문장</h4><div className="heraldry-toggle-grid"><div><label><input type="checkbox" checked={Boolean(displayFlag)} onChange={(event) => onChange({ displayFlag: event.target.checked })} /> 깃발 사용</label>{block("flag", Boolean(displayFlag), flagAssetId)}</div><div><label><input type="checkbox" checked={Boolean(displayCoat)} onChange={(event) => onChange({ displayCoatOfArms: event.target.checked })} /> 문장 사용</label>{block("coatOfArms", Boolean(displayCoat), coatAssetId)}</div></div></section>;
}
