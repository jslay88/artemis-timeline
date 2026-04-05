/* ════════════════════════════════════════════
   Artemis II — Internationalisation engine
   ════════════════════════════════════════════ */

export type LocaleStrings = Record<string, string>;
type LocaleDict = Record<string, LocaleStrings>;

import en from "./locales/en.ts";
import es from "./locales/es.ts";
import fr from "./locales/fr.ts";
import de from "./locales/de.ts";
import it from "./locales/it.ts";
import pt from "./locales/pt.ts";
import ja from "./locales/ja.ts";
import ko from "./locales/ko.ts";
import zh from "./locales/zh.ts";
import uk from "./locales/uk.ts";
import pl from "./locales/pl.ts";
import nl from "./locales/nl.ts";
import tr from "./locales/tr.ts";
import sv from "./locales/sv.ts";
import cs from "./locales/cs.ts";
import ro from "./locales/ro.ts";
import fa from "./locales/fa.ts";

const L: LocaleDict = { en, es, fr, de, it, pt, ja, ko, zh, uk, pl, nl, tr, sv, cs, ro, fa };

/* ════════════════════════════════════════════
   Engine
   ════════════════════════════════════════════ */

let _locale: string = "en";
const _listeners = new Set<(code: string) => void>();

export function t(key: string): string {
  return L[_locale]?.[key] ?? L.en[key] ?? key;
}

export function getLocale(): string {
  return _locale;
}

export function setLocale(code: string): void {
  if (!L[code]) return;
  _locale = code;
  document.documentElement.lang = code;
  document.title = t("title");
  localStorage.setItem("artemis-locale", code);
  applyI18nToDom();
  for (const fn of _listeners) fn(code);
}

export function onLocaleChange(fn: (code: string) => void): () => boolean {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function getLocales(): Array<{ code: string; name: string; flag: string }> {
  return Object.entries(L).map(([code, data]) => ({
    code,
    name: data._name,
    flag: data._flag ?? "",
  }));
}

export function applyI18nToDom(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n!);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
    el.innerHTML = t(el.dataset.i18nHtml!);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle!);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nLabel!));
  }
}

export function initI18n(): string {
  const stored = localStorage.getItem("artemis-locale");
  const browser: string | undefined = navigator.language?.split("-")[0];
  _locale =
    stored && L[stored] ? stored : browser !== undefined && L[browser] ? browser : "en";
  document.documentElement.lang = _locale;
  document.title = t("title");
  applyI18nToDom();
  return _locale;
}
