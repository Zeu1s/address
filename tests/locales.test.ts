import { describe, expect, it, vi } from 'vitest';
import { countries } from '../src/domain/countries';
import { englishMessages, messages } from '../src/domain/i18n';
import {
  isLocale, localeDefinitions, localeFromPath, localizedCountryName, matchLocale, pathForLocale, safeReturnPath, supportedLocales
} from '../src/domain/locales';

describe('localized URL routing', () => {
  it('normalizes return paths and rejects origin changes including backslash URLs', () => {
    const origin = 'https://address.example';
    for (const value of [null, '', '//untrusted.invalid/', '/\\untrusted.invalid/', '/\t/untrusted.invalid/',
      'https://untrusted.invalid/', 'javascript:alert(1)', 'relative']) {
      expect(safeReturnPath(value, origin, '/en/'), String(value)).toBe('/en/');
    }
    expect(safeReturnPath('/en/../zh-CN/?country=SG#filters', origin, '/en/')).toBe('/zh-CN/?country=SG#filters');
    expect(safeReturnPath('/en/?q=https://untrusted.invalid/', origin, '/en/')).toBe('/en/?q=https://untrusted.invalid/');
  });
  it('keeps the supported locale registry complete and uses autonyms', () => {
    expect(supportedLocales).toEqual(['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es', 'pt']);
    expect(localeDefinitions.map(({ label }) => label)).toEqual([
      'English', '简体中文', '繁體中文', '日本語', '한국어', 'Deutsch', 'Français', 'Español', 'Português'
    ]);
    expect(localeDefinitions.every(({ code }) => isLocale(code))).toBe(true);
  });

  it('matches exact, regional and Chinese script browser preferences', () => {
    expect(matchLocale(['fr-CA', 'en-US'])).toBe('fr');
    expect(matchLocale(['de-CH,de;q=0.9,en;q=0.8'])).toBe('de');
    expect(matchLocale(['zh-Hant-HK'])).toBe('zh-TW');
    expect(matchLocale(['zh-SG'])).toBe('zh-CN');
    expect(matchLocale(['unknown'])).toBe('en');
  });

  it('replaces only the locale segment and preserves the current page', () => {
    expect(localeFromPath('/ja/admin/')).toBe('ja');
    expect(localeFromPath('/admin/')).toBeUndefined();
    expect(pathForLocale('/zh-CN/', 'de')).toBe('/de/');
    expect(pathForLocale('/en/api/', 'fr')).toBe('/fr/api/');
    expect(pathForLocale('/admin/', 'ko')).toBe('/ko/admin/');
  });

  it('provides every frontend message key in every locale', () => {
    const keys = Object.keys(englishMessages).sort();
    for (const locale of supportedLocales) {
      expect(Object.keys(messages[locale]).sort(), locale).toEqual(keys);
      expect(Object.values(messages[locale]).every(Boolean), locale).toBe(true);
    }
  });
});

describe('country names', () => {
  it('render the same names on the server and in every browser engine', () => {
    vi.stubGlobal('Intl', { ...Intl, DisplayNames: class { of() { return 'engine-specific'; } } });
    try {
      for (const locale of supportedLocales) for (const country of countries) {
        const name = localizedCountryName(country.code, locale, 'fallback');
        expect(name, `${locale} ${country.code}`).not.toMatch(/^(engine-specific|fallback)$|SAR|特別行政區|特别行政区|特別行政区|특별행정구/u);
      }
      expect(localizedCountryName('HK', 'en', '')).toBe('Hong Kong');
      expect(localizedCountryName('KR', 'zh-CN', '')).toBe('韩国');
    } finally { vi.unstubAllGlobals(); }
  });
});
