/**
 * Root locale file (English).
 *
 * The `common.*` keys carry the settings-page language switch (see
 * `frontend/src/i18n/lib.ts` → `setLocale`). The rest of the app still uses the
 * Chinese literals; missing keys always fall back to `FALLBACK_LOCALE`
 * (`zh-Hans`) and then to the caller's `defaultValue`.
 */
import editor from "./editor/en-US.ts";

const enUS = {
  common: {
    appName: "Arkstage",
    language: "Language",
    languageHint: "Language of the UI and editor text; applied immediately and stored on this device.",
  },
  editor,
};

export default enUS;
