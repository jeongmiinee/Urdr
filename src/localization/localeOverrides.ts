import type { AppLanguage } from "./types";

const STORAGE_KEY = "world-archive-localization-overrides";
export const LOCALIZATION_OVERRIDE_EVENT = "world-archive:localization-overrides";

export type LocaleOverridePack = {
  schemaVersion: 1;
  language: AppLanguage;
  entries: Record<string, string>;
};

function readAll(): Partial<Record<AppLanguage, Record<string, string>>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Record<AppLanguage, Record<string, string>>>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(value: Partial<Record<AppLanguage, Record<string, string>>>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(LOCALIZATION_OVERRIDE_EVENT));
}

export function getLocaleOverride(language: AppLanguage, id: string): string | undefined {
  const value = readAll()[language]?.[id];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function setLocaleOverride(language: AppLanguage, id: string, value: string): void {
  const all = readAll();
  const entries = { ...(all[language] ?? {}) };
  if (value.trim()) entries[id] = value;
  else delete entries[id];
  writeAll({ ...all, [language]: entries });
}

export function resetLocaleOverrides(language: AppLanguage): void {
  const all = readAll();
  delete all[language];
  writeAll(all);
}

export function exportLocaleOverrides(language: AppLanguage): LocaleOverridePack {
  return { schemaVersion: 1, language, entries: { ...(readAll()[language] ?? {}) } };
}

export function importLocaleOverrides(pack: LocaleOverridePack): void {
  if (pack.schemaVersion !== 1 || (pack.language !== "ko" && pack.language !== "en") || !pack.entries || typeof pack.entries !== "object") {
    throw new Error("Unsupported language pack.");
  }
  const entries = Object.fromEntries(Object.entries(pack.entries).filter(([key, value]) => key && typeof value === "string"));
  const all = readAll();
  writeAll({ ...all, [pack.language]: entries });
}
