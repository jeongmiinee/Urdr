import { uiPhraseCatalog } from "../localization/locales/uiCatalog";
import type { WikiCategory, WorldProject } from "../model/world";

const koreanText = /[가-힣]/;
const genericDemoName =
  /^(?:Eterian\s+)?(?:Settlement|Faction|Country|Organization|Event|Place|Calendar Record|People Record)\s+\d+(?:\s+Territory)?$/i;

const CATEGORY_NAMES: Partial<Record<WikiCategory, string>> = {
  world: "World",
  calendar: "Calendars",
  country: "Countries",
  faction: "Factions",
  organization: "Organizations",
  order: "Orders",
  merchant_guild: "Merchant Guilds",
  mercenary_company: "Mercenary Companies",
  assassin_guild: "Assassin Guilds",
  knight_order: "Knightly Orders",
  city: "Cities",
  village: "Villages",
  fortress: "Fortresses",
  base: "Bases",
  location: "Places",
  person: "People",
  family: "Families",
  item: "Items",
  technology: "Technologies",
  technology_engineering: "Engineering",
  technology_mathematics: "Mathematics",
  technology_science: "Science",
  technology_chemistry: "Chemistry",
  technology_medicine: "Medicine",
  technology_physics: "Physics",
  culture_sphere: "Culture Spheres",
  culture: "Cultures",
  religion: "Religions",
  language: "Languages",
  language_family: "Language Families",
  language_branch: "Language Branches",
  language_group: "Language Groups",
  dialect: "Dialects",
  writing_system: "Writing Systems",
  ideology: "Ideologies",
  government: "Governments",
  event: "Events",
  accident: "Accidents",
  war: "Wars",
  battle: "Battles",
  animal: "Animals",
  plant: "Plants",
  tree: "Trees",
  rock: "Rocks",
  mineral: "Minerals",
  disease: "Diseases",
  other: "Other Records",
};

const MANUAL_NAMES: Record<string, string> = {
  "에테리아": "Eteria",
  "에테리아 세계": "Eteria",
  "성환력": "Astral Reckoning",
  "루나 여왕": "Queen Luna Selene",
  "카엘 왕자": "Prince Kael Selene",
  "미라 공녀": "Lady Mira Selene",
  "세레네 대공비": "Grand Duchess Serene",
  "셀레네 가문": "House Selene",
  "별나침반": "Star Compass",
  "은빛 왕관": "Silver Crown",
  "별빛 수로공학": "Starlit Hydraulic Engineering",
  "은빛 강 문화권": "Silver River Culture",
  "서부 수로 문화권": "Western Waterways Culture Sphere",
  "문화권": "Culture Spheres",
  "에테리아 공용어": "Common Eterian",
  "도시 자치주의": "Civic Autonomism",
  "입헌군주제": "Constitutional Monarchy",
  "별의 길 신앙": "Faith of the Starway",
  "안개 내해": "Misted Inland Sea",
  "조석력": "Tidal Reckoning",
  "실버동맹": "Silver Concord",
  "적염제국": "Cinder Empire",
  "아우렐리아 왕국": "Kingdom of Aurelia",
  "별빛 기사단": "Order of the Starway",
  "청람 상단": "Azure Ledger Guild",
  "녹원 협약": "Greenward Pact",
  "벨로란 공국": "Duchy of Veloran",
  "세르카 초원국": "Sercan Steppe",
  "루메아 상업동맹": "Lumean Trade League",
  "에이렌": "Eiren",
  "피르": "Fyr",
  "솔헤임": "Solheim",
  "네레이드 항": "Nereid Harbor",
  "카라드 관문": "Karad Gate",
  "아스텔라": "Astella",
  "발레온": "Valeon",
  "미라벨": "Miravel",
  "오르시스": "Orsis",
  "버드나루": "Willowford",
  "참나무골": "Oakvale",
  "해오름촌": "Sunrise Village",
  "고개샘": "Passwell",
  "푸른갈대": "Blue Reed",
  "모래등": "Sandridge",
  "붉은샘": "Redwell",
  "회암촌": "Graystone",
  "바람재": "Windpass",
  "달빛포구": "Moonhaven",
  "은어울": "Silverpool",
  "느릅벌": "Elmfield",
  "별무덤": "Starbarrow",
  "솔바위": "Pinerock",
  "새벽항": "Dawnharbor",
  "하린대성": "Harin Citadel",
  "세라황도": "Sera Crownroad",
  "카르경": "Kar Reach",
  "우르경": "Ur Reach",
  "칼렌경": "Kalen Reach",
  "우르항": "Ur Harbor",
  "세라도": "Serado",
  "퀼도": "Quildo",
  "로엔항": "Roen Harbor",
  "아르읍": "Ar Township",
  "프라장": "Fara Market",
  "마레역": "Mare Station",
  "칼렌역": "Kalen Station",
  "루메포": "Lume Quay",
  "벨역": "Bell Station",
  "노르샘": "Norwell",
  "로엔샘": "Roenwell",
  "이솔샘": "Isolwell",
  "칼렌리": "Kalen Village",
  "테른골": "Tern Hollow",
  "가람들": "Riverfield",
  "루메샘": "Lumewell",
  "엘름리": "Elm Village",
  "테른샘": "Ternwell",
  "도렌들": "Dorenfield",
  "페른들": "Fernfield",
  "엘름들": "Elmplain",
  "삼강 조약": "Treaty of Three Rivers",
  "동부 전쟁": "Eastern March War",
  "은빛 강 전투": "Battle of the Silver River",
  "대륙 횡단도로 공사": "Transcontinental Roadworks",
  "신에이렌 천년제": "New Eiren Millennium",
  "적염 대분화": "Great Cinder Eruption",
  "북방 설원 원정": "Northern Snowfield Expedition",
  "별나침반 탐험": "Star Compass Expedition",
  "네레이드 자유항 계약": "Nereid Freeport Charter",
  "네레이드 제7부두 붕괴": "Collapse of Nereid Seventh Pier",
  "적염 계승 사건": "Cinder Succession Crisis",
  "첫 별문 개방": "Opening of the First Stargate",
  "은빛 평원": "Silver Plain",
  "적염 산맥": "Cinder Range",
  "엘리아 노렌": "Elia Noren",
  "세렌 노렌": "Seren Noren",
  "토반 레스크": "Tovan Resk",
  "은빛조류 가문": "House Silvertide",
  "조위 관측회": "Tide Observatory",
  "칠등 신앙": "Faith of the Seven Lamps",
  "염수열": "Saltwater Fever",
  "습지해소병": "Marsh Cough",
  "조류날 검": "Tideblade",
  "푸른 장부": "The Blue Ledger",
  "역류 방지 조위문": "Reflux Tidal Gate",
  "은빛 단검": "Silver Dagger",
  "강철 비늘갑옷": "Steel Scale Armor",
  "초원뿔사슴": "Grassland Antler Deer",
  "청람벼": "Azure Reed Rice",
  "서릿골보리": "Frostvale Barley",
  "물결뿔염소": "Wavehorn Goat",
  "세르마 라디엔": "Serma Radien",
  "오르벤 칼리오": "Orven Kalio",
  "마엘라 에스틴": "Maela Estin",
  "로시안 테브르": "Rosian Tebre",
  "이사벨 노렌": "Isabel Noren",
  "다리온 베스크": "Darion Vesk",
  "셀리아 모르": "Celia Mor",
  "카이렌 아스트": "Kairen Ast",
  "고원 관측망 창설": "Founding of the Highland Observation Network",
  "서부 도시 중재회의": "Western Cities Arbitration",
  "대에이렌 수질 위기": "Greater Eiren Water Crisis",
  "옛 수로 복원 협약": "Old Waterway Restoration Accord",
  "연안 방재선 완공": "Completion of the Coastal Defense Line",
  "핵심 기록": "Core Record",
  "기원": "Origins",
  "첫 기록": "Earliest Record",
  "문서 조각": "Source Fragment",
  "영향": "Legacy and Impact",
  "생애": "Life",
  "활동과 관계": "Activities and Relations",
  "계보": "Lineage",
  "가문의 영향": "House Influence",
  "성립과 구조": "Foundation and Structure",
  "정치·사회적 관계": "Political and Social Relations",
  "지리": "Geography",
  "연혁": "History",
  "전개": "Course of Events",
  "결과와 영향": "Outcome and Impact",
  "기원과 용도": "Origin and Use",
  "소유와 전승": "Ownership and Transmission",
  "성립": "Foundation",
  "교리와 의례": "Doctrine and Ritual",
  "발병 기록": "Outbreak Record",
  "증상과 대응": "Symptoms and Response",
  "생태": "Ecology",
  "분포와 이용": "Distribution and Use",
  "제정": "Establishment",
  "운용 체계": "Operating System",
  "기록": "Record",
  "연관 관계": "Related Context",
  "14~18년": "14–18 years",
  "11~15년": "11–15 years",
  "한해살이": "Annual",
  "매년 초봄": "Early spring each year",
  "연 1회 파종·수확": "One sowing and harvest each year",
  "14개월": "14 months",
  "태생": "Live birth",
  "체력 회복력 -20%": "Health recovery -20%",
  "집중력 -10%": "Concentration -10%",
  "중증 시 일시적 보행 장애": "Temporary mobility impairment in severe cases",
  "활동 지구력 -15%": "Activity endurance -15%",
  "세계는 일곱 해류가 감싸는 하나의 등불이다.": "The world is one lantern encircled by seven currents.",
  "등불은 신격이 아니라 기억을 잇는 공동체의 약속이다.": "The lamps are a communal covenant of memory rather than deities.",
  "항해자의 꿈과 조수표의 반복에서 계시를 읽는다.": "Revelation is read in sailors' dreams and recurring tide tables.",
  "귀환할 길을 남기고 물과 불을 독점하지 않는다.": "Leave a path home and never monopolize water or flame.",
  "매월 마지막 환에 항로등을 함께 밝힌다.": "Navigation lamps are lit together on the final Hwan of each month.",
  "죽은 이의 이름은 일곱 항로등 가운데 하나에 기록된다.": "Each dead person's name is recorded at one of the seven navigation lamps.",
  "수등관과 각 항구의 등지기가 의례를 맡는다.": "Tide-light keepers and each harbor's lamplighters conduct the rites.",
  "칠등 항해록과 귀환 서약": "The Seven-Lamp Logbook and Covenant of Return",
  "난파 신호를 외면하거나 공동 우물을 오염시키는 행위": "Ignoring a distress signal or polluting a communal well",
  "항구별 등원과 대수등회": "Harbor lamp houses and the Grand Tide-Light Council",
  "성해어족": "Astral-Sea Family",
  "어족": "Language Families",
  "어파": "Language Branches",
  "어군": "Language Groups",
  "방언": "Dialects",
  "문자": "Writing Systems",
  "조류어파": "Tidal Branch",
  "은류어군": "Silverflow Group",
  "항로문자": "Route Script",
  "은빛강 방언": "Silver River Dialect",
  "아렌": "aren",
  "세일": "seil",
  "아레나": "arena",
  "렌": "ren",
  "세일라": "seila",
  "체력": "Health",
  "인지력": "Perception",
  "회복 시까지": "Until recovery",
  "발열 기간": "During fever",
  "증상 기간": "While symptomatic",
  "탈수 증상이 지속되는 동안": "While dehydration persists",
  "고열 상태": "During high fever",
  "격렬한 활동 시": "During strenuous activity",
  "적염 산맥 북서 사면의 석영맥과 고대 충돌구": "Quartz veins and ancient impact sites on the northwestern Cinder Range",
  "약 1,460°C": "Approximately 1,460°C",
  "모스 경도 7.5": "Mohs hardness 7.5",
  "별빛과 마력을 장시간 저장한 뒤 청백색으로 발광한다.": "Stores starlight and magic for long periods before emitting a blue-white glow.",
  "항법구, 조위문 감응부, 의례용 등불의 핵심 재료": "Core material for navigation orbs, tidal-gate sensors, and ceremonial lamps",
  "급격히 가열하면 저장 에너지가 폭발적으로 방출된다.": "Rapid heating releases its stored energy explosively.",
  "에이렌 서부 산계의 기반암대와 은빛 강 상류 협곡": "Bedrock belts of the western Eiren ranges and the upper Silver River gorge",
  "압축 강도 약 180MPa": "Compressive strength approximately 180 MPa",
  "석영과 장석이 만든 밝고 어두운 띠가 조위 방향과 평행하게 발달한다.": "Light and dark bands of quartz and feldspar develop parallel to the tidal orientation.",
  "수문 기초석, 교량 교대, 기념비 외장재": "Tidal-gate foundations, bridge abutments, and monument cladding",
  "층리 방향으로 절단하면 동결 융해에 의해 얇게 박리된다.": "Cuts along its foliation can delaminate under freeze-thaw cycles.",
  "조석력 1217~1218년": "Tidal Reckoning 1217–1218",
  "조석력 1198년": "Tidal Reckoning 1198",
  "엘리아 노렌과 서부 도시 중재회": "Elia Noren and the Western Cities Arbitration Council",
  "조석력 1240~1268년": "Tidal Reckoning 1240–1268",
  "도시 자치, 수자원 공동관리, 공개 회계, 교역로의 중립": "Municipal autonomy, shared water governance, public accounting, and neutral trade routes",
};

const NAME_PREFIXES = [
  "Amber", "Ashen", "Azure", "Bright", "Cedar", "Dawn", "Ember", "Frost",
  "Golden", "Hollow", "Iron", "Jade", "Lunar", "Misted", "North", "Quiet",
  "River", "Silver", "Stone", "Verdant", "West", "White",
];
const NAME_ROOTS = [
  "Anchor", "Archive", "Beacon", "Bridge", "Cairn", "Crown", "Field", "Gate",
  "Harbor", "Lantern", "March", "Orchard", "Pact", "Reed", "Road", "Sanctum",
  "Spire", "Spring", "Tide", "Vale", "Ward", "Watch",
];

const proseKeys = new Set([
  "summary", "content", "description", "notes", "note", "cause", "result", "impact",
  "locationText", "condition", "purpose", "origin", "alignment", "symbol", "incubationPeriod",
  "symptomNotes", "keyFigures", "scale", "explanation",
  "temperatureRange", "humidityRange", "lifespan", "reproductionCycle", "birthMethod",
  "cosmology", "divinity", "revelation", "ethics", "ritual", "afterlife", "clergy",
  "sacredTexts", "prohibitions", "organization", "symptoms", "aftereffects", "condition",
  "phonology", "phonotactics", "morphology", "syntax", "wordOrder", "grammaticalCategories",
  "writingSystem", "numerals", "registers", "historicalDevelopment", "dialects", "meaning",
  "etymology", "usageNote",
]);

function categoryName(category: WikiCategory | undefined): string {
  return category ? CATEGORY_NAMES[category] ?? "Records" : "Records";
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function distinctiveName(source: string, noun: string, used: Set<string>): string {
  const hash = stableHash(`${noun}:${source}`);
  for (let offset = 0; offset < NAME_PREFIXES.length * NAME_ROOTS.length; offset += 1) {
    const prefix = NAME_PREFIXES[(hash + offset * 7) % NAME_PREFIXES.length];
    const root = NAME_ROOTS[(Math.floor(hash / NAME_PREFIXES.length) + offset * 11) % NAME_ROOTS.length];
    const candidate = `${prefix} ${root} ${noun}`.replace(/\s+/g, " ").trim();
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return `Unnamed ${noun}`;
}

export function createEnglishDemoProject(source: WorldProject): WorldProject {
  const project = structuredClone(source);
  const replacements = new Map<string, string>(Object.entries(MANUAL_NAMES));
  const fallback = new Map<string, string>();
  const usedNames = new Set(replacements.values());

  const remember = (from: string | undefined, to: string) => {
    if (
      from
      && (koreanText.test(from) || genericDemoName.test(from))
      && !replacements.has(from)
    ) {
      replacements.set(from, to);
    }
  };

  remember(project.title, "Eteria World");
  project.wikiCategories.forEach((category) => {
    remember(category.name, CATEGORY_NAMES[category.systemKey ?? category.templateKey ?? "other"] ?? distinctiveName(category.name, "Archive", usedNames));
  });
  project.maps.forEach((map) => {
    remember(map.title, MANUAL_NAMES[map.title] ?? distinctiveName(map.title, "Map", usedNames));
    map.factions.forEach((faction) => {
      const label = faction.kind === "country" ? "Country" : faction.kind === "faction" ? "Faction" : "Organization";
      remember(faction.name, MANUAL_NAMES[faction.name] ?? distinctiveName(faction.name, label, usedNames));
    });
    map.locations.forEach((location) => location.states.forEach((state) => {
      remember(state.value.name, MANUAL_NAMES[state.value.name] ?? distinctiveName(state.value.name, "Settlement", usedNames));
    }));
    map.events.forEach((event) => remember(event.title, MANUAL_NAMES[event.title] ?? distinctiveName(event.title, "Event", usedNames)));
    map.placeNames.forEach((placeName) => remember(placeName.name, MANUAL_NAMES[placeName.name] ?? distinctiveName(placeName.name, "Region", usedNames)));
    map.mountains.forEach((mountain) => remember(mountain.name, MANUAL_NAMES[mountain.name] ?? distinctiveName(mountain.name, "Peak", usedNames)));
  });
  project.heraldicAssets.forEach((asset) => {
    remember(asset.name, distinctiveName(asset.name, asset.kind === "flag" ? "Flag" : "Emblem", usedNames));
  });
  project.wikiArticles.forEach((article) => {
    if (
      (!koreanText.test(article.title) && !genericDemoName.test(article.title))
      || replacements.has(article.title)
    ) return;
    const label = categoryName(article.category);
    remember(article.title, distinctiveName(article.title, label.replace(/s$/, ""), usedNames));
  });

  const orderedReplacements = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);
  const translateString = (sourceValue: string, key: string): string => {
    if (!koreanText.test(sourceValue)) return sourceValue;
    const exact = replacements.get(sourceValue) ?? uiPhraseCatalog[sourceValue];
    if (exact) return exact;
    let translated = sourceValue;
    for (const [from, to] of orderedReplacements) translated = translated.replaceAll(from, to);
    for (const [from, to] of Object.entries(uiPhraseCatalog)) {
      if (from.length > 1 && translated.includes(from)) translated = translated.replaceAll(from, to);
    }
    if (!koreanText.test(translated)) return translated;
    const cached = fallback.get(sourceValue);
    if (cached) return cached;
    const links = [...translated.matchAll(/\[\[([^\]]+)]]/g)].map((match) => `[[${match[1]}]]`);
    const value = key === "tags"
      ? "English Demo"
      : proseKeys.has(key)
        ? `This Eterian record documents a local cause, the people and institutions involved, and its consequences across the shared chronology.${links.length ? ` Related records: ${links.join(", ")}.` : ""}`
        : distinctiveName(sourceValue, "Record", usedNames);
    fallback.set(sourceValue, value);
    return value;
  };

  const translateValue = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") return translateString(value, key);
    if (Array.isArray(value)) return value.map((item) => translateValue(item, key));
    if (!value || typeof value !== "object") return value;
    for (const [childKey, childValue] of Object.entries(value)) {
      (value as Record<string, unknown>)[childKey] = translateValue(childValue, childKey);
    }
    return value;
  };

  return translateValue(project) as WorldProject;
}

export function containsKoreanDemoText(project: WorldProject): boolean {
  return koreanText.test(JSON.stringify(project));
}
