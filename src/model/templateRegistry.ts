import type { WikiCategory } from "./world";

export type WikiTemplateDefinition = {
  key: WikiCategory;
  label: string;
  description: string;
  special: boolean;
};

export const WIKI_TEMPLATE_REGISTRY: WikiTemplateDefinition[] = [
  { key: "other", label: "일반", description: "자유 서술형 일반 문서", special: false },
  { key: "person", label: "인물", description: "생몰년·관계·소속 정보", special: true },
  { key: "family", label: "가문", description: "가계도와 구성원 정보", special: true },
  { key: "organization", label: "단체", description: "지도자·본부·목표 정보", special: true },
  { key: "faction", label: "세력", description: "지도자·사상·활동 범위 정보", special: true },
  { key: "country", label: "국가", description: "정치 체제·국교·언어·문화 정보", special: true },
  { key: "calendar", label: "역법", description: "날짜·시간 단위와 역초 설정", special: true },
  { key: "event", label: "사건", description: "시작·종료·참여자·상세 연표", special: true },
  { key: "accident", label: "사고", description: "사고·재해 전용 사건 문서", special: true },
  { key: "war", label: "전쟁", description: "전쟁 전용 사건 문서", special: true },
  { key: "battle", label: "전투", description: "전투 전용 사건 문서", special: true },
  { key: "item", label: "물건", description: "기원·상태·소유권 기록", special: true },
  { key: "religion", label: "종교", description: "창시·상징·관련 단체 정보", special: true },
  { key: "city", label: "장소", description: "지도 위치와 시대별 장소 정보", special: true },
  { key: "animal", label: "동물", description: "자연·생태 동물 문서", special: false },
  { key: "plant", label: "식물", description: "자연·생태 식물 문서", special: false },
  { key: "tree", label: "나무", description: "산림·목재·수목 문서", special: false },
  { key: "rock", label: "암석", description: "지질·암석 문서", special: false },
  { key: "mineral", label: "광물", description: "광물·자원 문서", special: false },
  { key: "disease", label: "질병", description: "질병·유행병 문서", special: false },
];

export function templateDefinition(key?: WikiCategory): WikiTemplateDefinition {
  return WIKI_TEMPLATE_REGISTRY.find((item) => item.key === key) ?? WIKI_TEMPLATE_REGISTRY[0];
}
