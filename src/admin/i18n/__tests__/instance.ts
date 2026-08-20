import i18next, { type i18n, type TFunction } from "i18next";
import { initReactI18next } from "react-i18next";
import resources from "../index";

/**
 * The plugin's own translations, in an i18next configured the way the dashboard
 * configures its own.
 *
 * `fallbackNS` is the load-bearing option and it is copied from the dashboard
 * deliberately (`defaultI18nOptions` in `@medusajs/dashboard`). These strings are
 * registered in the default `translation` namespace under a `usage.` prefix, so a
 * lookup made against the `usage` namespace - which is what the sidebar label
 * does - only resolves because it falls back to `translation`. A test that
 * initialised i18next without it would pass while the real screen showed raw
 * keys.
 *
 * Nothing here is reachable from a route or a widget, so it never reaches the
 * admin bundle.
 */
const OPTIONS = {
  fallbackLng: "en",
  fallbackNS: "translation",
  interpolation: { escapeValue: false },
  resources,
} as const;

/** A `t` for one language, for the pure functions that take one. */
export async function translator(lng: "en" | "pl"): Promise<TFunction> {
  const instance = i18next.createInstance();
  await instance.init({ ...OPTIONS, lng });
  return instance.t;
}

/**
 * The shared instance the components pick up through `useTranslation`.
 *
 * `useSuspense` is off because `renderToStaticMarkup` cannot suspend: a component
 * that threw a promise here would fail the test rather than wait for anything.
 */
export async function mountI18n(lng: "en" | "pl"): Promise<i18n> {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      ...OPTIONS,
      lng,
      react: { useSuspense: false },
    });
  }
  await i18next.changeLanguage(lng);
  return i18next;
}
