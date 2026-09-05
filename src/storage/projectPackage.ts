import {
  generatedAtYear,
  getStateAtYear,
  type MapData,
  type WorldProject,
} from "../model/world";

export type ProjectExportProfile = "package" | "development" | "runtime";

type PackageEntry = { path: string; bytes: Uint8Array; mediaType: string; encoding?: "gzip" };
type PackageManifest = {
  format: "world-archive-package";
  schemaVersion: 1;
  profile: ProjectExportProfile;
  applicationVersion: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activeMapId: string | null;
  timeline: { mapId: string | null; year: number | null };
  conventions: { coordinates: string; distance: string; elevation: string; time: string };
  files: Array<{ path: string; bytes: number; mediaType: string; encoding?: "gzip"; sha256: string }>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value, null, 2));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([exactBuffer(bytes)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([exactBuffer(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", exactBuffer(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "record";
}

function writeU16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function writeU32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true); }

/** Creates a standards-compatible ZIP using stored entries; large map records are GZIP payloads inside it. */
function createStoredZip(entries: PackageEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path.replace(/\\/g, "/"));
    const crc = crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length + entry.bytes.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0x0800);
    writeU16(localView, 8, 0);
    writeU32(localView, 14, crc);
    writeU32(localView, 18, entry.bytes.length);
    writeU32(localView, 22, entry.bytes.length);
    writeU16(localView, 26, name.length);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0x0800);
    writeU16(centralView, 10, 0);
    writeU32(centralView, 16, crc);
    writeU32(centralView, 20, entry.bytes.length);
    writeU32(centralView, 24, entry.bytes.length);
    writeU16(centralView, 28, name.length);
    writeU32(centralView, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeU32(endView, 0, 0x06054b50);
  writeU16(endView, 8, entries.length);
  writeU16(endView, 10, entries.length);
  writeU32(endView, 12, centralSize);
  writeU32(endView, 16, localOffset);
  const output = new Uint8Array(localOffset + centralSize + end.length);
  let offset = 0;
  for (const part of [...localParts, ...centralParts, end]) { output.set(part, offset); offset += part.length; }
  return output;
}

function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1)
    if (view.getUint32(offset, true) === 0x06054b50) { endOffset = offset; break; }
  if (endOffset < 0) throw new Error("URDR 패키지의 ZIP 끝 레코드를 찾지 못했습니다.");
  const count = view.getUint16(endOffset + 10, true);
  let centralOffset = view.getUint32(endOffset + 16, true);
  const entries = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) throw new Error("URDR 패키지의 파일 목록이 손상되었습니다.");
    const method = view.getUint16(centralOffset + 10, true);
    const size = view.getUint32(centralOffset + 24, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const name = decoder.decode(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength));
    if (method !== 0 || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`지원하지 않는 패키지 엔트리입니다: ${name}`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, bytes.slice(dataOffset, dataOffset + size));
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function relationIndex(project: WorldProject): Array<{ sourceId: string; targetId: string; field: string }> {
  const knownIds = new Set([
    ...project.wikiArticles.map((article) => article.id),
    ...project.maps.map((map) => map.id),
    ...project.maps.flatMap((map) => [...map.locations, ...map.factions, ...map.territories].map((entry) => entry.id)),
  ]);
  const result: Array<{ sourceId: string; targetId: string; field: string }> = [];
  const walk = (sourceId: string, value: unknown, field: string, seen: WeakSet<object>) => {
    if (typeof value === "string") {
      if (knownIds.has(value) && value !== sourceId) result.push({ sourceId, targetId: value, field });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) value.forEach((item, index) => walk(sourceId, item, `${field}[${index}]`, seen));
    else for (const [key, item] of Object.entries(value)) walk(sourceId, item, field ? `${field}.${key}` : key, seen);
  };
  for (const article of project.wikiArticles) walk(article.id, article, "", new WeakSet());
  return result.filter((edge, index) => result.findIndex((candidate) => candidate.sourceId === edge.sourceId && candidate.targetId === edge.targetId && candidate.field === edge.field) === index);
}

export function validateProjectPackageReferences(project: WorldProject): string[] {
  const errors: string[] = [];
  const duplicateIds = (scope: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id) errors.push(`${scope}에 빈 ID가 있습니다.`);
      else if (seen.has(id)) errors.push(`${scope}에 중복 ID가 있습니다: ${id}`);
      seen.add(id);
    }
  };
  duplicateIds("지도", project.maps.map((map) => map.id));
  duplicateIds("문서", project.wikiArticles.map((article) => article.id));
  duplicateIds("카테고리", project.wikiCategories.map((category) => category.id));
  duplicateIds("RPG 그룹", project.rpgSettings.groups.map((group) => group.id));
  duplicateIds("RPG 정의", project.rpgSettings.definitions.map((definition) => definition.id));
  if (project.activeMapId && !project.maps.some((map) => map.id === project.activeMapId)) errors.push(`활성 지도 참조가 없습니다: ${project.activeMapId}`);

  const categoryIds = new Set(project.wikiCategories.map((category) => category.id));
  for (const category of project.wikiCategories)
    if (category.parentId && !categoryIds.has(category.parentId)) errors.push(`${category.id}의 상위 카테고리가 없습니다: ${category.parentId}`);
  const mapEntityIds = new Set(project.maps.flatMap((map) => [
    ...map.locations.map((entry) => entry.id), ...map.factions.map((entry) => entry.id),
    ...map.territories.map((entry) => entry.id), ...map.events.map((entry) => entry.id),
  ]));
  for (const article of project.wikiArticles) {
    if (article.categoryId && !categoryIds.has(article.categoryId)) errors.push(`${article.id}의 카테고리가 없습니다: ${article.categoryId}`);
    for (const id of article.linkedMapEntityIds)
      if (!mapEntityIds.has(id)) errors.push(`${article.id}의 지도 엔티티 참조가 없습니다: ${id}`);
    if (article.sourceMapId && !project.maps.some((map) => map.id === article.sourceMapId)) errors.push(`${article.id}의 원본 지도가 없습니다: ${article.sourceMapId}`);
    if (article.sourceEntityId && !mapEntityIds.has(article.sourceEntityId)) errors.push(`${article.id}의 원본 엔티티가 없습니다: ${article.sourceEntityId}`);
  }
  for (const map of project.maps) {
    duplicateIds(`${map.id} 지도 엔티티`, [
      ...map.locations.map((entry) => entry.id), ...map.factions.map((entry) => entry.id),
      ...map.territories.map((entry) => entry.id), ...map.events.map((entry) => entry.id),
    ]);
    const factionIds = new Set(map.factions.map((faction) => faction.id));
    const locationIds = new Set(map.locations.map((location) => location.id));
    const territoryIds = new Set(map.territories.map((territory) => territory.id));
    for (const location of map.locations) for (const state of location.states)
      if (state.value.ownerFactionId && !factionIds.has(state.value.ownerFactionId)) errors.push(`${location.id}의 소유 세력이 없습니다: ${state.value.ownerFactionId}`);
    for (const territory of map.territories) for (const state of territory.states)
      if (state.value.ownerFactionId && !factionIds.has(state.value.ownerFactionId)) errors.push(`${territory.id}의 소유 세력이 없습니다: ${state.value.ownerFactionId}`);
    for (const event of map.events) {
      for (const id of event.relatedLocationIds) if (!locationIds.has(id)) errors.push(`${event.id}의 장소 참조가 없습니다: ${id}`);
      for (const id of event.relatedFactionIds) if (!factionIds.has(id)) errors.push(`${event.id}의 세력 참조가 없습니다: ${id}`);
      for (const id of event.relatedTerritoryIds) if (!territoryIds.has(id)) errors.push(`${event.id}의 영토 참조가 없습니다: ${id}`);
    }
  }
  const outerCategoryIds = new Set(project.rpgSettings.definitionCategories.map((category) => category.id));
  const groupIds = new Set(project.rpgSettings.groups.map((group) => group.id));
  for (const group of project.rpgSettings.groups)
    if (group.categoryId && !outerCategoryIds.has(group.categoryId)) errors.push(`${group.id}의 RPG 바깥 범주가 없습니다: ${group.categoryId}`);
  for (const definition of project.rpgSettings.definitions)
    if (!groupIds.has(definition.groupId)) errors.push(`${definition.id}의 RPG 그룹이 없습니다: ${definition.groupId}`);
  return [...new Set(errors)];
}

function generatedGridBundle(map: MapData): { bytes: Uint8Array; metadata: unknown } | null {
  const generated = generatedAtYear(map, map.timeline.currentYear);
  if (!generated) return null;
  const cellCount = generated.gridWidth * generated.gridHeight;
  const fields: Array<{ name: string; type: "float32" | "uint32"; values: Float32Array | Uint32Array; dictionary?: string[] }> = [];
  for (const [name, candidate] of Object.entries(generated)) {
    if (!Array.isArray(candidate) || candidate.length !== cellCount || candidate.length === 0) continue;
    if (candidate.every((value) => typeof value === "number"))
      fields.push({ name, type: "float32", values: Float32Array.from(candidate as number[]) });
    else if (candidate.every((value) => typeof value === "string")) {
      const dictionary = [...new Set(candidate as string[])];
      const index = new Map(dictionary.map((value, position) => [value, position]));
      fields.push({ name, type: "uint32", values: Uint32Array.from((candidate as string[]).map((value) => index.get(value) ?? 0)), dictionary });
    }
  }
  const totalBytes = fields.reduce((sum, field) => sum + field.values.byteLength, 0);
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  const metadataFields = fields.map((field) => {
    bytes.set(new Uint8Array(field.values.buffer, field.values.byteOffset, field.values.byteLength), offset);
    const metadata = { name: field.name, type: field.type, offset, length: field.values.length, ...(field.dictionary ? { dictionary: field.dictionary } : {}) };
    offset += field.values.byteLength;
    return metadata;
  });
  return {
    bytes,
    metadata: {
      mapId: map.id,
      year: map.timeline.currentYear,
      width: generated.gridWidth,
      height: generated.gridHeight,
      byteOrder: "little-endian",
      compression: "gzip",
      fields: metadataFields,
    },
  };
}

async function editableEntries(project: WorldProject, profile: "package" | "development"): Promise<PackageEntry[]> {
  const { maps, wikiArticles, wikiCategories, rpgSettings, simulationSummaries, linkedTextFields, heraldicAssets, worldSettings, ...root } = project;
  const entries: PackageEntry[] = [
    { path: "project/root.json", bytes: jsonBytes(root), mediaType: "application/json" },
    { path: "world/settings.json", bytes: jsonBytes(worldSettings), mediaType: "application/json" },
    { path: "wiki/categories.json", bytes: jsonBytes(wikiCategories), mediaType: "application/json" },
    { path: "rpg/settings.json", bytes: jsonBytes(rpgSettings), mediaType: "application/json" },
    { path: "simulation/summaries.json", bytes: jsonBytes(simulationSummaries), mediaType: "application/json" },
    { path: "links/text-fields.json", bytes: jsonBytes(linkedTextFields), mediaType: "application/json" },
    { path: "relationships/index.json", bytes: jsonBytes(relationIndex(project)), mediaType: "application/json" },
    { path: "assets/heraldry.json", bytes: jsonBytes(heraldicAssets), mediaType: "application/json" },
  ];
  const articleGroups = new Map<string, typeof wikiArticles>();
  for (const article of wikiArticles) articleGroups.set(article.category, [...(articleGroups.get(article.category) ?? []), article]);
  for (const [category, articles] of articleGroups)
    entries.push({ path: `entities/${safeSegment(category)}.json`, bytes: jsonBytes(articles), mediaType: "application/json" });
  for (const map of maps) {
    const { generatedStates, ...metadata } = map;
    const directory = `maps/${safeSegment(map.id)}`;
    entries.push({ path: `${directory}/map.json`, bytes: jsonBytes(metadata), mediaType: "application/json" });
    entries.push({ path: `${directory}/generated-states.json.gz`, bytes: await gzip(jsonBytes(generatedStates)), mediaType: "application/json", encoding: "gzip" });
    if (profile === "development") {
      entries.push({ path: `${directory}/features.geojson`, bytes: jsonBytes(runtimeGeoJson(map, map.timeline.currentYear)), mediaType: "application/geo+json" });
      const grids = generatedGridBundle(map);
      if (grids) {
        entries.push({ path: `${directory}/grids.json`, bytes: jsonBytes(grids.metadata), mediaType: "application/json" });
        entries.push({ path: `${directory}/grids.bin.gz`, bytes: await gzip(grids.bytes), mediaType: "application/octet-stream", encoding: "gzip" });
      }
    }
  }
  entries.push({ path: "maps/index.json", bytes: jsonBytes(maps.map((map) => ({ id: map.id, path: `maps/${safeSegment(map.id)}/map.json`, generatedStates: `maps/${safeSegment(map.id)}/generated-states.json.gz` }))), mediaType: "application/json" });
  if (profile === "development") {
    entries.push({ path: "schemas/README.md", bytes: encoder.encode("# URDR interchange schema\n\nAll cross-file references use stable IDs. Canonical map generated states are UTF-8 JSON compressed with GZIP. Current-time grids are little-endian typed arrays described by each grids.json and compressed as grids.bin.gz. Vector features are GeoJSON. Coordinates use map world units; physical widths are kilometres and elevations are metres.\n"), mediaType: "text/markdown" });
    entries.push({ path: "schemas/world-archive.d.ts", bytes: encoder.encode("export type StableId = string;\nexport type WorldArchiveManifest = { format: 'world-archive-package'; schemaVersion: 1; projectId: StableId; profile: 'package' | 'development' | 'runtime' };\n"), mediaType: "text/plain" });
    const manifestSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "URDR Manifest",
      type: "object",
      required: ["format", "schemaVersion", "profile", "projectId", "files"],
      additionalProperties: true,
      properties: {
        format: { const: "world-archive-package" },
        schemaVersion: { const: 1 },
        profile: { enum: ["package", "development", "runtime"] },
        projectId: { type: "string", minLength: 1 },
        files: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "bytes", "mediaType", "sha256"],
            properties: {
              path: { type: "string" }, bytes: { type: "integer", minimum: 0 },
              mediaType: { type: "string" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
          },
        },
      },
    };
    const entitySchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "URDR Entity Record",
      type: "object",
      required: ["id", "title", "category"],
      additionalProperties: true,
      properties: {
        id: { type: "string", minLength: 1 }, title: { type: "string" }, category: { type: "string" },
        categoryId: { type: ["string", "null"] }, linkedMapEntityIds: { type: "array", items: { type: "string" } },
      },
    };
    entries.push({ path: "schemas/manifest.schema.json", bytes: jsonBytes(manifestSchema), mediaType: "application/schema+json" });
    entries.push({ path: "schemas/entity.schema.json", bytes: jsonBytes(entitySchema), mediaType: "application/schema+json" });
  }
  return entries;
}

function runtimeGeoJson(map: MapData, year: number): unknown {
  const generated = generatedAtYear(map, year);
  const features: Array<Record<string, unknown>> = [];
  for (const location of map.locations) {
    const state = getStateAtYear(location.states, year);
    if (state) features.push({ type: "Feature", id: location.id, properties: { kind: "location", ...state }, geometry: { type: "Point", coordinates: [state.position.x, state.position.y] } });
  }
  for (const road of map.roads) features.push({ type: "Feature", id: road.id, properties: { kind: "road", name: road.name }, geometry: { type: "LineString", coordinates: road.nodes.map((point) => [point.x, point.y]) } });
  for (const edge of generated?.riverGraph?.edges ?? []) if (edge.render)
    features.push({ type: "Feature", id: `river-${edge.id}`, properties: { kind: "river", order: edge.order, magnitude: edge.magnitude }, geometry: { type: "LineString", coordinates: edge.centerline.map((point) => [point.x, point.y]) } });
  for (const territory of map.territories) {
    const state = getStateAtYear(territory.states, year);
    for (const [index, part] of (state?.parts ?? []).entries()) features.push({ type: "Feature", id: `${territory.id}-${index}`, properties: { kind: "territory", ownerFactionId: state?.ownerFactionId }, geometry: { type: "Polygon", coordinates: [part.polygon, ...(part.holes ?? [])].map((ring) => ring.map((point) => [point.x, point.y])) } });
  }
  return { type: "FeatureCollection", worldArchive: { mapId: map.id, year }, features };
}

function runtimeEntries(project: WorldProject): PackageEntry[] {
  const map = project.maps.find((candidate) => candidate.id === project.activeMapId) ?? project.maps[0];
  const year = map?.timeline.currentYear ?? 0;
  const snapshot = {
    project: { id: project.id, title: project.title, description: project.description, version: project.version },
    worldSettings: project.worldSettings,
    rpg: project.rpgSettings,
    map: map ? {
      id: map.id, title: map.title, physicalWidthKm: map.physicalWidthKm, width: map.width, height: map.height, year,
      locations: map.locations.map((entry) => ({ id: entry.id, value: getStateAtYear(entry.states, year) })).filter((entry) => entry.value),
      factions: map.factions,
      territories: map.territories.map((entry) => ({ id: entry.id, value: getStateAtYear(entry.states, year) })).filter((entry) => entry.value),
      events: map.events.filter((event) => event.startYear <= year && (event.endYear === null || event.endYear >= year)),
    } : null,
    entities: project.wikiArticles,
    relationships: relationIndex(project),
  };
  return [
    { path: "runtime/snapshot.json", bytes: jsonBytes(snapshot), mediaType: "application/json" },
    ...(map ? [{ path: "runtime/map.geojson", bytes: jsonBytes(runtimeGeoJson(map, year)), mediaType: "application/geo+json" }] : []),
  ];
}

export async function buildProjectPackage(project: WorldProject, profile: ProjectExportProfile): Promise<Uint8Array> {
  const referenceErrors = validateProjectPackageReferences(project);
  if (referenceErrors.length) throw new Error(`프로젝트 참조 무결성 검사에 실패했습니다:\n${referenceErrors.slice(0, 12).join("\n")}`);
  const activeMap = project.maps.find((map) => map.id === project.activeMapId) ?? project.maps[0];
  const dataEntries = profile === "runtime" ? runtimeEntries(project) : await editableEntries(project, profile);
  const files = await Promise.all(dataEntries.map(async (entry) => ({
    path: entry.path,
    bytes: entry.bytes.length,
    mediaType: entry.mediaType,
    ...(entry.encoding ? { encoding: entry.encoding } : {}),
    sha256: await sha256(entry.bytes),
  })));
  const manifest: PackageManifest = {
    format: "world-archive-package",
    schemaVersion: 1,
    profile,
    applicationVersion: project.version,
    projectId: project.id,
    title: project.title,
    createdAt: project.createdDate,
    updatedAt: project.lastModifiedDate,
    activeMapId: project.activeMapId,
    timeline: { mapId: activeMap?.id ?? null, year: activeMap?.timeline.currentYear ?? null },
    conventions: { coordinates: "map-local Cartesian world units", distance: "kilometres for physicalWidthKm", elevation: "metres", time: "URDR world year" },
    files,
  };
  return createStoredZip([{ path: "manifest.json", bytes: jsonBytes(manifest), mediaType: "application/json" }, ...dataEntries]);
}

function requireEntry(entries: Map<string, Uint8Array>, path: string): Uint8Array {
  const value = entries.get(path);
  if (!value) throw new Error(`URDR 패키지에 ${path} 파일이 없습니다.`);
  return value;
}

export async function parseProjectPackage(bytes: Uint8Array): Promise<WorldProject> {
  const entries = readStoredZip(bytes);
  const manifest = JSON.parse(decoder.decode(requireEntry(entries, "manifest.json"))) as PackageManifest;
  if (manifest.format !== "world-archive-package" || manifest.schemaVersion !== 1 || manifest.profile === "runtime")
    throw new Error("편집 가능한 URDR 패키지가 아닙니다.");
  for (const file of manifest.files) {
    const payload = requireEntry(entries, file.path);
    if (await sha256(payload) !== file.sha256) throw new Error(`패키지 파일 해시가 일치하지 않습니다: ${file.path}`);
  }
  const parseJson = <T,>(path: string): T => JSON.parse(decoder.decode(requireEntry(entries, path))) as T;
  const root = parseJson<Omit<WorldProject, "maps" | "wikiArticles" | "wikiCategories" | "worldSettings" | "rpgSettings" | "simulationSummaries" | "linkedTextFields" | "heraldicAssets">>("project/root.json");
  const mapIndex = parseJson<Array<{ id: string; path: string; generatedStates: string }>>("maps/index.json");
  const maps = await Promise.all(mapIndex.map(async (record) => ({
    ...parseJson<Omit<MapData, "generatedStates">>(record.path),
    generatedStates: JSON.parse(decoder.decode(await gunzip(requireEntry(entries, record.generatedStates)))),
  } as MapData)));
  const wikiArticles = [...entries.entries()]
    .filter(([path]) => path.startsWith("entities/") && path.endsWith(".json"))
    .flatMap(([, payload]) => JSON.parse(decoder.decode(payload)));
  const project = {
    ...root,
    maps,
    wikiArticles,
    wikiCategories: parseJson("wiki/categories.json"),
    worldSettings: parseJson("world/settings.json"),
    rpgSettings: parseJson("rpg/settings.json"),
    simulationSummaries: parseJson("simulation/summaries.json"),
    linkedTextFields: parseJson("links/text-fields.json"),
    heraldicAssets: parseJson("assets/heraldry.json"),
  } as WorldProject;
  const referenceErrors = validateProjectPackageReferences(project);
  if (referenceErrors.length) throw new Error(`프로젝트 참조 무결성 검사에 실패했습니다:\n${referenceErrors.slice(0, 12).join("\n")}`);
  return project;
}

export function downloadPackageBrowser(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([exactBuffer(bytes)], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
