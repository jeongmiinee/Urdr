export type LocalizedRpgLabel = { ko: string; en: string };
export type RpgValueKind = "integer" | "decimal" | "percentage" | "dice" | "text" | "boolean" | "choice";
export type RpgScalarValue = number | string | boolean;
export type RpgModifierOperator = "flat_add" | "percent_add" | "multiply" | "override" | "minimum" | "maximum";
export type RpgModifierSourceKind = "personal" | "family" | "equipment" | "affiliation" | "other";
export type RpgActivationMode = "always" | "equipped" | "carried" | "worn" | "wielded" | "consumed" | "manual";
export type RpgDefinitionKind = "attribute" | "profession";

export type RpgStatGroup = {
  id: string;
  categoryId?: string;
  kind?: RpgDefinitionKind;
  label: LocalizedRpgLabel;
  order: number;
  magicOnly?: boolean;
  builtIn?: boolean;
  archived?: boolean;
};

export type RpgDefinitionCategory = {
  id: string;
  label: LocalizedRpgLabel;
  order: number;
  builtIn?: boolean;
};

export type RpgStatDefinition = {
  id: string;
  categoryId: string;
  groupId: string;
  key: string;
  label: LocalizedRpgLabel;
  shortLabel?: LocalizedRpgLabel;
  description?: LocalizedRpgLabel;
  valueKind: RpgValueKind;
  unit?: string;
  defaultValue?: RpgScalarValue;
  minimum?: number;
  maximum?: number;
  step?: number;
  precision?: number;
  choices?: Array<{ id: string; label: LocalizedRpgLabel }>;
  formula?: string;
  order: number;
  magicOnly?: boolean;
  kind?: RpgDefinitionKind;
  archived?: boolean;
};

export type RpgSheetTemplate = {
  id: string;
  label: LocalizedRpgLabel;
  groupIds: string[];
  statIds: string[];
  compatibleCategories: string[];
  order: number;
};

export type RpgModifier = {
  id: string;
  statId: string;
  operator: RpgModifierOperator;
  value: number;
  sourceKind: RpgModifierSourceKind;
  sourceArticleId?: string;
  sourceTraitId?: string;
  condition?: string;
  note?: string;
  description?: string;
  priority: number;
  activationMode?: RpgActivationMode;
  active?: boolean;
  startYear?: number;
  endYear?: number | null;
};

export type RpgFamilyTraitScope = "all_members" | "lineal" | "collateral" | "selected_members";
export type RpgTrait = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  modifiers: RpgModifier[];
  familyArticleId?: string;
  scope: RpgFamilyTraitScope;
  anchorArticleId?: string;
  selectedArticleIds: string[];
  maximumKinshipDegree?: number;
  includeSpouses: boolean;
  includeAdopted: boolean;
};

export type RpgAttackProfile = {
  id: string;
  name: string;
  damage: number | string;
  methods: Array<"thrust" | "slash" | "blunt" | "arrow" | "bullet" | "magic">;
  attributes: Array<"normal" | "fire" | "poison" | "explosion" | "cold" | "contamination" | "electricity">;
};

export type RpgArmorProfile = {
  defense: number;
  durability: number;
  methodDefense: Record<"thrust" | "slash" | "blunt" | "arrow" | "bullet" | "magic", boolean>;
  attributes: Array<"normal" | "fire" | "poison" | "explosion" | "cold" | "contamination" | "electricity">;
};

export type RpgGrantedEffect = {
  id: string;
  name?: string;
  description?: string;
  modifiers: RpgModifier[];
  targetType: "citizens" | "members" | "leaders" | "locations" | "adherents" | "organizations" | "selected";
  targetArticleIds: string[];
  activationMode: RpgActivationMode;
  active: boolean;
  startYear?: number;
  endYear?: number | null;
};

export type RpgArticleData = {
  enabled: boolean;
  sheetIds: string[];
  visibleGroupIds: string[];
  values: Record<string, RpgScalarValue>;
  modifiers: RpgModifier[];
  traitIds: string[];
  attackProfiles: RpgAttackProfile[];
  armorProfile?: RpgArmorProfile;
  grantedEffects: RpgGrantedEffect[];
};

export type RpgProjectSettings = {
  enabled: boolean;
  magicEnabled: boolean;
  definitionCategories: RpgDefinitionCategory[];
  groups: RpgStatGroup[];
  definitions: RpgStatDefinition[];
  sheets: RpgSheetTemplate[];
  traits: RpgTrait[];
  modifierOrder: RpgModifierOperator[];
};

const label = (ko: string, en: string): LocalizedRpgLabel => ({ ko, en });

export function createDefaultRpgSettings(enabled = false, magicEnabled = false): RpgProjectSettings {
  const definitionCategories: RpgDefinitionCategory[] = [
    { id: "character-attributes", label: label("인물 고유 수치", "Character Attributes"), order: 10, builtIn: true },
    { id: "equipment-attributes", label: label("장비 고유 수치", "Equipment Attributes"), order: 20, builtIn: true },
    { id: "character-professions", label: label("인물 숙련도", "Character Professions"), order: 30, builtIn: true },
  ];
  const allGroups: RpgStatGroup[] = [
    { id: "person-core", categoryId: "character-attributes", kind: "attribute", label: label("역량", "Capabilities"), order: 10, builtIn: true },
    { id: "person-disposition", categoryId: "character-attributes", kind: "attribute", label: label("성향", "Disposition"), order: 20, builtIn: true },
    { id: "magic", categoryId: "character-attributes", kind: "attribute", label: label("마법력", "Magic Power"), order: 30, magicOnly: true, builtIn: true },
    { id: "equipment-common", categoryId: "equipment-attributes", kind: "attribute", label: label("장비 공통", "Equipment Common"), order: 40, builtIn: true },
    { id: "equipment-weapon", categoryId: "equipment-attributes", kind: "attribute", label: label("무기", "Weapons"), order: 50, builtIn: true },
    { id: "equipment-armor", categoryId: "equipment-attributes", kind: "attribute", label: label("방어구", "Armor"), order: 60, builtIn: true },
    { id: "equipment-accessory", categoryId: "equipment-attributes", kind: "attribute", label: label("장신구", "Accessories"), order: 70, builtIn: true },
    { id: "equipment-item", categoryId: "equipment-attributes", kind: "attribute", label: label("일반 물건", "General Items"), order: 80, builtIn: true },
    { id: "profession-weapon", categoryId: "character-professions", kind: "profession", label: label("무기 스킬", "Weapon Skills"), order: 90, builtIn: true },
    { id: "profession-magic", categoryId: "character-professions", kind: "profession", label: label("마법 스킬", "Magic Skills"), order: 100, magicOnly: true, builtIn: true },
    { id: "profession-activity", categoryId: "character-professions", kind: "profession", label: label("활동 스킬", "Activity Skills"), order: 110, builtIn: true },
    { id: "profession-occupation", categoryId: "character-professions", kind: "profession", label: label("직업 스킬", "Job Skills"), order: 120, builtIn: true },
  ];
  const attributeDefinitions: RpgStatDefinition[] = [
    ["health", "체력", "Health", "person-core"], ["strength", "근력", "Strength", "person-core"],
    ["agility", "민첩성", "Agility", "person-core"], ["perception", "인지력", "Perception", "person-core"],
    ["intelligence", "지능", "Intelligence", "person-core"], ["charm", "매력", "Charm", "person-core"],
    ["luck", "운", "Luck", "person-core"], ["willpower", "의지력", "Willpower", "person-disposition"],
    ["social", "사회성", "Social Ability", "person-disposition"],
    ["morality", "도덕성", "Morality", "person-disposition"], ["curiosity", "호기심", "Curiosity", "person-disposition"],
    ["faith", "신앙심", "Faith", "person-disposition"], ["loyalty", "충성심", "Loyalty", "person-disposition"],
    ["mana", "마법력", "Magic Power", "magic"], ["mana_regeneration", "마법 회복력", "Magic Regeneration", "magic"],
    ["magic_defense", "마법 방어력", "Magic Defense", "magic"], ["magic_projection", "마법 전개력", "Magic Projection", "magic"],
    ["durability", "내구도", "Durability", "equipment-common"],
    ["damage", "피해량", "Damage", "equipment-weapon"], ["defense", "방어력", "Defense", "equipment-armor"],
  ].map(([id, ko, en, groupId], index) => ({
    id, key: id, groupId,
    categoryId: groupId.startsWith("equipment-") ? "equipment-attributes" : "character-attributes",
    kind: "attribute" as const,
    label: label(ko, en), valueKind: "integer" as const,
    minimum: 0, maximum: 999_999, step: 1, precision: 0, order: (index + 1) * 10,
    magicOnly: groupId === "magic",
  }));
  const professionDefinitions: RpgStatDefinition[] = [
    ["profession-dagger", "단검", "Dagger", "profession-weapon"],
    ["profession-sword", "검", "Sword", "profession-weapon"],
    ["profession-axe", "도끼", "Axe", "profession-weapon"],
    ["profession-spear", "창", "Spear", "profession-weapon"],
    ["profession-blunt", "둔기", "Blunt Weapon", "profession-weapon"],
    ["profession-bow", "활", "Bow", "profession-weapon"],
    ["profession-crossbow", "쇠뇌", "Crossbow", "profession-weapon"],
    ["profession-firearm", "총", "Firearm", "profession-weapon"],
    ["profession-destruction", "파괴류", "Destruction", "profession-magic"],
    ["profession-control", "조종류", "Control", "profession-magic"],
    ["profession-healing", "치유류", "Healing", "profession-magic"],
    ["profession-transformation", "변형류", "Transformation", "profession-magic"],
    ["profession-bargaining", "흥정", "Bargaining", "profession-activity"],
    ["profession-communication", "소통", "Communication", "profession-activity"],
    ["profession-leadership", "통솔", "Leadership", "profession-activity"],
    ["profession-tactics", "전술", "Tactics", "profession-activity"],
    ["profession-strategy", "전략", "Strategy", "profession-activity"],
  ].map(([id, ko, en, groupId], index) => ({
    id,
    key: id,
    groupId,
    categoryId: "character-professions",
    kind: "profession" as const,
    label: label(ko, en),
    valueKind: "integer" as const,
    minimum: 0,
    maximum: 999_999,
    step: 1,
    precision: 0,
    order: (index + 1) * 10,
    magicOnly: groupId === "profession-magic",
  }));
  const allDefinitions = [...attributeDefinitions, ...professionDefinitions];
  const groups = allGroups.filter((group) => magicEnabled || !group.magicOnly);
  const definitions = allDefinitions.filter((definition) => magicEnabled || !definition.magicOnly);
  const idsForGroups = (...groupIds: string[]) => definitions.filter((definition) => groupIds.includes(definition.groupId)).map((definition) => definition.id);
  const characterGroupIds = ["person-core", "person-disposition", ...(magicEnabled ? ["magic"] : []), "profession-weapon", ...(magicEnabled ? ["profession-magic"] : []), "profession-activity", "profession-occupation"];
  const equipmentGroupIds = ["equipment-common", "equipment-weapon", "equipment-armor", "equipment-accessory", "equipment-item"];
  const sheets: RpgSheetTemplate[] = [
    { id: "character", label: label("인물", "Character"), groupIds: characterGroupIds, statIds: idsForGroups(...characterGroupIds), compatibleCategories: ["person"], order: 10 },
    { id: "creature", label: label("생물", "Creature"), groupIds: ["person-core", ...(magicEnabled ? ["magic"] : [])], statIds: idsForGroups("person-core", ...(magicEnabled ? ["magic"] : [])), compatibleCategories: ["animal"], order: 20 },
    { id: "weapon", label: label("장비-무기", "Equipment - Weapon"), groupIds: ["equipment-common", "equipment-weapon"], statIds: ["durability", "damage"], compatibleCategories: ["item"], order: 30 },
    { id: "armor", label: label("장비-방어구", "Equipment - Armor"), groupIds: ["equipment-common", "equipment-armor"], statIds: ["durability", "defense"], compatibleCategories: ["item"], order: 40 },
    { id: "general-item", label: label("일반 물건", "General Item"), groupIds: equipmentGroupIds, statIds: idsForGroups(...equipmentGroupIds), compatibleCategories: ["item"], order: 50 },
    { id: "plant", label: label("식물", "Plant"), groupIds: [], statIds: [], compatibleCategories: ["plant"], order: 60 },
    { id: "bloodline", label: label("가문 특성", "Bloodline"), groupIds: [], statIds: [], compatibleCategories: ["family"], order: 70 },
  ];
  return {
    enabled,
    magicEnabled,
    definitionCategories,
    groups,
    definitions,
    sheets,
    traits: [],
    modifierOrder: ["flat_add", "percent_add", "multiply", "minimum", "maximum", "override"],
  };
}

export function createEmptyRpgArticleData(sheetIds: string[] = []): RpgArticleData {
  return { enabled: true, sheetIds, visibleGroupIds: [], values: {}, modifiers: [], traitIds: [], attackProfiles: [], grantedEffects: [] };
}

export function defaultRpgDataForCategory(settings: RpgProjectSettings, category: string): RpgArticleData | undefined {
  if (!settings.enabled) return undefined;
  const automatic: Record<string, string | undefined> = {
    person: "character", family: "bloodline", item: "general-item", animal: "creature", plant: "plant",
  };
  const sheetId = automatic[category];
  return sheetId ? createEmptyRpgArticleData([sheetId]) : undefined;
}

export function setRpgMagicEnabled(settings: RpgProjectSettings, magicEnabled: boolean): RpgProjectSettings {
  const magicGroupIds = ["magic", "profession-magic"];
  const magicStatIds = settings.definitions.filter((definition) => magicGroupIds.includes(definition.groupId)).map((definition) => definition.id);
  return {
    ...settings,
    magicEnabled,
    sheets: settings.sheets.map((sheet) => {
      if (sheet.id !== "character" && sheet.id !== "creature") return sheet;
      const allowedMagicGroups = sheet.id === "character" ? magicGroupIds : ["magic"];
      const allowedMagicStats = settings.definitions.filter((definition) => allowedMagicGroups.includes(definition.groupId)).map((definition) => definition.id);
      return {
        ...sheet,
        groupIds: magicEnabled
          ? [...new Set([...sheet.groupIds, ...allowedMagicGroups])]
          : sheet.groupIds.filter((id) => !magicGroupIds.includes(id)),
        statIds: magicEnabled
          ? [...new Set([...sheet.statIds, ...allowedMagicStats])]
          : sheet.statIds.filter((id) => !magicStatIds.includes(id)),
      };
    }),
  };
}
