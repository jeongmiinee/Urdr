import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { enMessages } from "./locales/en";
import { koMessages, type MessageKey } from "./locales/ko";
import type { AppLanguage } from "./types";
import { installUiLocalization } from "./uiText";
import { getLocaleOverride, LOCALIZATION_OVERRIDE_EVENT } from "./localeOverrides";

const LANGUAGE_STORAGE_KEY = "world-archive-language";

type MessageValues = Record<string, string | number>;

type LocalizationContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  t: (key: MessageKey, values?: MessageValues) => string;
};

const LocalizationContext = createContext<LocalizationContextValue | null>(null);

function initialLanguage(): AppLanguage {
  try {
    const storage = typeof window !== "undefined" ? window.localStorage : globalThis.localStorage;
    return storage?.getItem(LANGUAGE_STORAGE_KEY) === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

function interpolate(message: string, values?: MessageValues): string {
  if (!values) return message;
  return message.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

export function LocalizationProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<AppLanguage>(initialLanguage);
  const [translationRevision, setTranslationRevision] = useState(0);

  useEffect(() => {
    document.documentElement.lang = language === "ko" ? "ko" : "en";
    document.documentElement.dataset.language = language;
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Session-only fallback. */ }
  }, [language]);

  useEffect(() => installUiLocalization(language), [language, translationRevision]);

  useEffect(() => {
    const refresh = () => setTranslationRevision((revision) => revision + 1);
    window.addEventListener(LOCALIZATION_OVERRIDE_EVENT, refresh);
    return () => window.removeEventListener(LOCALIZATION_OVERRIDE_EVENT, refresh);
  }, []);

  const value = useMemo<LocalizationContextValue>(() => ({
    language,
    setLanguage,
    t: (key, values) => interpolate(getLocaleOverride(language, `message:${key}`) ?? (language === "en" ? enMessages : koMessages)[key], values),
  }), [language, translationRevision]);

  return <LocalizationContext.Provider value={value}>{children}</LocalizationContext.Provider>;
}

export function useLocalization(): LocalizationContextValue {
  const value = useContext(LocalizationContext);
  if (!value) throw new Error("useLocalization must be used inside LocalizationProvider");
  return value;
}
