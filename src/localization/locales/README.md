# Locale Catalogs

All files are plain UTF-8 source files.

- `ko.ts`: authoritative Korean semantic messages.
- `en.ts`: English semantic messages with the same stable keys.
- `uiCatalog.ts`: reviewed compatibility translations for older UI that has not yet moved to semantic keys.
- `GLOSSARY.en.md`: preferred English product terminology.

Run `npm run localization:audit` after editing. The audit checks key parity, placeholders, empty English values, Korean fallback, and uncatalogued JSX labels. Date, number, unit, duration, and calendar formatting do not belong here.

The Settings localization workspace stores local translator overrides outside project data. Exported `*.language-pack.json` files can be shared and imported into another client.
