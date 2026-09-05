# Localization

This folder owns interface language selection, translation keys, and message catalogs only.

- Edit source and translated messages in `locales/ko.ts` and `locales/en.ts`.
- Use the localization workspace in Settings for searchable review, live preview, and local JSON language-pack import/export.
- `locales/uiCatalog.ts` holds the reviewed compatibility catalog for older hard-coded interface labels. `uiText.ts` only applies that catalog to legacy UI nodes.
- Do not place date, number, sorting, search, or calendar formatting here.
- Never translate or rewrite user-authored project content when the interface language changes.
