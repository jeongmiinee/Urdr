import type { AppLanguage } from "../localization/types";

export function localeForLanguage(language: AppLanguage): string {
  return language === "en" ? "en-US" : "ko-KR";
}

export function formatNumber(value: number, language: AppLanguage, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(localeForLanguage(language), options).format(value);
}

export function formatDateTime(value: string | number | Date, language: AppLanguage): string {
  return new Intl.DateTimeFormat(localeForLanguage(language), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function normalizeSearchText(value: string, language: AppLanguage): string {
  return value.normalize("NFKC").toLocaleLowerCase(localeForLanguage(language)).trim();
}

export function compareDisplayText(a: string, b: string, language: AppLanguage): number {
  return a.localeCompare(b, localeForLanguage(language), { numeric: true, sensitivity: "base" });
}

