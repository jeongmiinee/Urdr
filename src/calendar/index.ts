import { formatTimelineMoment, type TimelineState, type WikiArticle, type WorldProject } from "../model/world";
import type { AppLanguage } from "../localization/types";

export function formatTimelineForLanguage(
  project: WorldProject,
  timeline: TimelineState,
  language: AppLanguage,
  article?: WikiArticle | null,
): string {
  const formatted = formatTimelineMoment(project, timeline, article);
  if (language === "ko" || article?.calendarProfile) return formatted;
  return formatted
    .replace(/(-?\d+)년/g, "$1 year")
    .replace(/(\d+)월/g, "month $1")
    .replace(/(\d+)일/g, "day $1")
    .replace(/(\d+)시/g, "$1h")
    .replace(/(\d+)분/g, "$1m")
    .replace(/\s+주간$/, " week");
}

