import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createId, type WorldProject } from "../model/world";
import type {
  RpgDefinitionKind,
  RpgProjectSettings,
  RpgStatDefinition,
  RpgStatGroup,
  RpgValueKind,
} from "../rpg/schema";
import { useLocalization } from "../localization";

type Props = {
  project: WorldProject;
  settings: RpgProjectSettings;
  onChange: (settings: RpgProjectSettings) => void;
};

const VALUE_KINDS: Array<{ id: RpgValueKind; label: string }> = [
  { id: "integer", label: "정수" }, { id: "decimal", label: "소수" },
  { id: "percentage", label: "백분율" }, { id: "dice", label: "주사위" },
  { id: "text", label: "텍스트" }, { id: "boolean", label: "예/아니오" },
  { id: "choice", label: "선택 목록" },
];

function referencesToDefinition(project: WorldProject, definitionId: string): number {
  let count = 0;
  for (const article of project.wikiArticles) {
    const data = article.rpgData;
    if (!data) continue;
    if (Object.hasOwn(data.values, definitionId)) count += 1;
    count += data.modifiers.filter((modifier) => modifier.statId === definitionId).length;
    for (const grant of data.grantedEffects)
      count += grant.modifiers.filter((modifier) => modifier.statId === definitionId).length;
  }
  for (const trait of project.rpgSettings.traits)
    count += trait.modifiers.filter((modifier) => modifier.statId === definitionId).length;
  return count;
}

function moveOrdered<T extends { id: string; order: number }>(items: T[], id: string, direction: -1 | 1): T[] {
  const ordered = [...items].sort((a, b) => a.order - b.order);
  const index = ordered.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ordered.length) return items;
  const currentOrder = ordered[index].order;
  const targetOrder = ordered[target].order;
  return items.map((item) => item.id === ordered[index].id ? { ...item, order: targetOrder }
    : item.id === ordered[target].id ? { ...item, order: currentOrder } : item);
}

export function RpgRulesPanel({ project, settings, onChange }: Props) {
  const { language } = useLocalization();
  const orderedCategories = useMemo(
    () => [...settings.definitionCategories].sort((a, b) => a.order - b.order),
    [settings.definitionCategories],
  );
  const [selectedCategoryId, setSelectedCategoryId] = useState(orderedCategories[0]?.id ?? "character-attributes");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const categoryTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const groups = settings.groups
    .filter((group) => !group.archived && group.categoryId === selectedCategoryId)
    .filter((group) => settings.magicEnabled || !group.magicOnly)
    .sort((a, b) => a.order - b.order);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0];
  const definitions = settings.definitions
    .filter((definition) => !definition.archived && definition.groupId === selectedGroup?.id)
    .filter((definition) => settings.magicEnabled || !definition.magicOnly)
    .sort((a, b) => a.order - b.order);
  const archivedCount = settings.groups.filter((group) => group.archived && group.categoryId === selectedCategoryId).length
    + settings.definitions.filter((definition) => definition.archived && definition.categoryId === selectedCategoryId).length;

  useEffect(() => {
    if (!orderedCategories.some((category) => category.id === selectedCategoryId))
      setSelectedCategoryId(orderedCategories[0]?.id ?? "character-attributes");
  }, [orderedCategories, selectedCategoryId]);
  useEffect(() => {
    if (!groups.some((group) => group.id === selectedGroupId)) setSelectedGroupId(groups[0]?.id ?? "");
  }, [groups, selectedGroupId]);

  const patchGroup = (id: string, patch: Partial<RpgStatGroup>) => onChange({
    ...settings,
    groups: settings.groups.map((group) => group.id === id ? { ...group, ...patch } : group),
  });
  const patchDefinition = (id: string, patch: Partial<RpgStatDefinition>) => onChange({
    ...settings,
    definitions: settings.definitions.map((definition) => definition.id === id ? { ...definition, ...patch } : definition),
  });
  const addGroup = () => {
    const id = createId("rpg-group");
    const kind: RpgDefinitionKind = selectedCategoryId === "character-professions" ? "profession" : "attribute";
    const group: RpgStatGroup = {
      id,
      categoryId: selectedCategoryId,
      kind,
      label: { ko: kind === "profession" ? "새 숙련도 그룹" : "새 고유 수치 그룹", en: kind === "profession" ? "New Profession Group" : "New Attribute Group" },
      order: Math.max(0, ...settings.groups.map((entry) => entry.order)) + 10,
    };
    onChange({ ...settings, groups: [...settings.groups, group] });
    setSelectedGroupId(id);
  };
  const addDefinition = () => {
    if (!selectedGroup) return;
    const id = createId(selectedGroup.kind === "profession" ? "profession" : "attribute");
    const definition: RpgStatDefinition = {
      id,
      key: id,
      categoryId: selectedCategoryId,
      groupId: selectedGroup.id,
      kind: selectedGroup.kind ?? "attribute",
      label: { ko: selectedGroup.kind === "profession" ? "새 숙련도" : "새 고유 수치", en: selectedGroup.kind === "profession" ? "New Profession" : "New Attribute" },
      valueKind: "integer",
      minimum: 0,
      maximum: 100,
      step: 1,
      precision: 0,
      order: Math.max(0, ...settings.definitions.filter((entry) => entry.groupId === selectedGroup.id).map((entry) => entry.order)) + 10,
    };
    onChange({
      ...settings,
      definitions: [...settings.definitions, definition],
      sheets: settings.sheets.map((sheet) => sheet.id === "character" && selectedGroup.kind === "profession"
        ? { ...sheet, groupIds: [...new Set([...sheet.groupIds, selectedGroup.id])], statIds: [...new Set([...sheet.statIds, id])] }
        : sheet),
    });
  };
  const removeDefinition = (definition: RpgStatDefinition) => {
    const references = referencesToDefinition(project, definition.id);
    if (references > 0) {
      if (!window.confirm(`${definition.label.ko}은(는) ${references}곳에서 사용 중입니다. 값을 보존한 채 보관할까요?`)) return;
      patchDefinition(definition.id, { archived: true });
      return;
    }
    if (!window.confirm(`${definition.label.ko} 항목을 삭제할까요?`)) return;
    onChange({
      ...settings,
      definitions: settings.definitions.filter((entry) => entry.id !== definition.id),
      sheets: settings.sheets.map((sheet) => ({ ...sheet, statIds: sheet.statIds.filter((id) => id !== definition.id) })),
    });
  };
  const removeGroup = () => {
    if (!selectedGroup) return;
    const children = settings.definitions.filter((definition) => definition.groupId === selectedGroup.id);
    const references = children.reduce((sum, definition) => sum + referencesToDefinition(project, definition.id), 0);
    if (children.length > 0 || references > 0) {
      if (!window.confirm(`${selectedGroup.label.ko} 그룹과 하위 항목을 보관할까요? 기존 문서 값과 효과 참조는 유지됩니다.`)) return;
      onChange({
        ...settings,
        groups: settings.groups.map((group) => group.id === selectedGroup.id ? { ...group, archived: true } : group),
        definitions: settings.definitions.map((definition) => definition.groupId === selectedGroup.id ? { ...definition, archived: true } : definition),
      });
      return;
    }
    if (!window.confirm(`${selectedGroup.label.ko} 빈 그룹을 삭제할까요?`)) return;
    onChange({ ...settings, groups: settings.groups.filter((group) => group.id !== selectedGroup.id) });
  };
  const restoreArchived = () => onChange({
    ...settings,
    groups: settings.groups.map((group) => group.categoryId === selectedCategoryId ? { ...group, archived: false } : group),
    definitions: settings.definitions.map((definition) => definition.categoryId === selectedCategoryId ? { ...definition, archived: false } : definition),
  });
  const selectRelativeCategory = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!direction || orderedCategories.length === 0) return;
    event.preventDefault();
    const nextIndex = (index + direction + orderedCategories.length) % orderedCategories.length;
    setSelectedCategoryId(orderedCategories[nextIndex].id);
    categoryTabRefs.current[nextIndex]?.focus();
  };

  return <section className="rpg-rules-panel">
    <div className="window-heading compact"><h2>RPG 규칙</h2></div>
    <p className="dialog-hint">고유 수치는 인물·장비 자체의 값이며, 숙련도는 인물에게만 부여됩니다.</p>
    <div className="rpg-definition-category-bar fixed">
      <div className="rpg-definition-tabs" role="tablist" aria-label="RPG 규칙 영역">
        {orderedCategories.map((category, index) => <button
          type="button" role="tab" id={`rpg-category-tab-${category.id}`} aria-controls="rpg-category-panel"
          aria-selected={category.id === selectedCategoryId} tabIndex={category.id === selectedCategoryId ? 0 : -1}
          className={category.id === selectedCategoryId ? "active" : ""} key={category.id}
          ref={(element) => { categoryTabRefs.current[index] = element; }}
          onKeyDown={(event) => selectRelativeCategory(event, index)} onClick={() => setSelectedCategoryId(category.id)}
        >{category.label[language]}</button>)}
      </div>
    </div>
    <div id="rpg-category-panel" className="rpg-category-panel" role="tabpanel" aria-labelledby={`rpg-category-tab-${selectedCategoryId}`}>
      <div className="rpg-group-toolbar">
        <div className="rpg-group-tabs" role="tablist" aria-label="수치 그룹">
          {groups.map((group) => <button type="button" role="tab" aria-selected={group.id === selectedGroup?.id} className={group.id === selectedGroup?.id ? "active" : ""} key={group.id} onClick={() => setSelectedGroupId(group.id)}>{group.label[language]}</button>)}
        </div>
        <button type="button" className="icon-button secondary-button" title="그룹 추가" aria-label="그룹 추가" onClick={addGroup}>＋</button>
      </div>
      {selectedGroup ? <>
        <div className="rpg-category-name-editor rpg-group-name-editor">
          <label>그룹명<input value={selectedGroup.label.ko} onChange={(event) => patchGroup(selectedGroup.id, { label: { ...selectedGroup.label, ko: event.target.value } })} /></label>
          <label>영문명<input value={selectedGroup.label.en} onChange={(event) => patchGroup(selectedGroup.id, { label: { ...selectedGroup.label, en: event.target.value } })} /></label>
          <div className="rpg-order-actions"><button type="button" className="icon-button" title="앞으로" onClick={() => onChange({ ...settings, groups: moveOrdered(settings.groups, selectedGroup.id, -1) })}>↑</button><button type="button" className="icon-button" title="뒤로" onClick={() => onChange({ ...settings, groups: moveOrdered(settings.groups, selectedGroup.id, 1) })}>↓</button><button type="button" className="icon-button danger-ghost" title="그룹 삭제" onClick={removeGroup}>×</button></div>
        </div>
        <div className="rpg-definition-toolbar"><strong>{selectedGroup.kind === "profession" ? "숙련도 정의" : "고유 수치 정의"}</strong><button type="button" className="secondary-button" onClick={addDefinition}>＋ 항목</button></div>
        <div className="rpg-definition-list">
          {definitions.map((definition) => <div className="rpg-definition-row hierarchical" key={definition.id}>
            <input aria-label="한국어 항목명" value={definition.label.ko} onChange={(event) => patchDefinition(definition.id, { label: { ...definition.label, ko: event.target.value } })} />
            <input aria-label="영어 항목명" value={definition.label.en} onChange={(event) => patchDefinition(definition.id, { label: { ...definition.label, en: event.target.value } })} />
            <select aria-label="값 형식" value={definition.valueKind} onChange={(event) => patchDefinition(definition.id, { valueKind: event.target.value as RpgValueKind })}>{VALUE_KINDS.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}</select>
            <div className="rpg-order-actions"><button type="button" className="icon-button" title="위로" onClick={() => onChange({ ...settings, definitions: moveOrdered(settings.definitions, definition.id, -1) })}>↑</button><button type="button" className="icon-button" title="아래로" onClick={() => onChange({ ...settings, definitions: moveOrdered(settings.definitions, definition.id, 1) })}>↓</button><button type="button" className="icon-button danger-ghost" title="항목 삭제" aria-label={`${definition.label.ko} 삭제`} onClick={() => removeDefinition(definition)}>×</button></div>
          </div>)}
          {definitions.length === 0 && <p className="empty-hint">이 그룹에는 아직 항목이 없습니다.</p>}
        </div>
      </> : <p className="empty-hint">그룹을 추가해 규칙을 정의하세요.</p>}
      {archivedCount > 0 && <button type="button" className="secondary-button rpg-archive-restore" onClick={restoreArchived}>보관 항목 {archivedCount}개 복구</button>}
    </div>
    <div className="rpg-stacking-order"><strong>효과 계산 순서</strong><span>{settings.modifierOrder.join(" → ")}</span></div>
  </section>;
}
