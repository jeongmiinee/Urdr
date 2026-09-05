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
  { key: "culture_sphere", label: "문화권", description: "여러 문화를 아우르는 분포권과 연결 관계", special: true },
  { key: "culture", label: "문화", description: "분포 지역·언어·종교와 사용자 정의 특징", special: true },
  { key: "technology_engineering", label: "공학", description: "공학 기술의 제작자·시기·특징", special: true },
  { key: "technology_mathematics", label: "수학", description: "수학 이론과 방법의 제작자·시기·특징", special: true },
  { key: "technology_science", label: "과학", description: "과학 지식의 제작자·시기·특징", special: true },
  { key: "technology_chemistry", label: "화학", description: "화학 기술의 제작자·시기·특징", special: true },
  { key: "technology_medicine", label: "의학", description: "의학 지식의 제작자·시기·특징", special: true },
  { key: "technology_physics", label: "물리학", description: "물리학 이론의 제작자·시기·특징", special: true },
  { key: "technology", label: "기타 기술", description: "기타 기술의 제작자·시기·특징", special: true },
  { key: "language_family", label: "어족", description: "공통 조상과 하위 언어 계통", special: true },
  { key: "language_branch", label: "어파", description: "어족 내부의 주요 계통", special: true },
  { key: "language_group", label: "어군", description: "어파 내부의 근연 언어군", special: true },
  { key: "language", label: "언어", description: "언어 구조·문법·어휘", special: true },
  { key: "dialect", label: "방언", description: "상위 언어와 지역 변이", special: true },
  { key: "writing_system", label: "문자", description: "표기 체계와 문자 운용", special: true },
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
