import type { AppLanguage } from "../localization";
import type { WorldProject } from "../model/world";
import { StructuredInfoPanel, StructuredInfoRow } from "./StructuredInfoPanel";

export function WorldProfilePanel({ project, language }: { project: WorldProject; language: AppLanguage }) {
  const korean = language === "ko";
  return <StructuredInfoPanel title={korean ? "세계 정보" : "World Information"} className="world-profile-panel">
    <StructuredInfoRow label={korean ? "RPG 규칙 여부" : "RPG Rules Enabled"}>{project.rpgSettings.enabled ? (korean ? "사용" : "Enabled") : (korean ? "미사용" : "Disabled")}</StructuredInfoRow>
    <StructuredInfoRow label={korean ? "마법 여부" : "Magic Exists"}>{project.worldSettings.magicEnabled ? (korean ? "존재" : "Exists") : (korean ? "없음" : "None")}</StructuredInfoRow>
  </StructuredInfoPanel>;
}
