/**
 * Which reading language the console keeps for a browser.
 *
 * A visit reads the language the deployment pinned (`OMCPA_DEFAULT_LANGUAGE`), or its own when the
 * deployment pinned none, until the reader chooses one - and only that choice is stored. Storing
 * the language a visit arrived in would pin this browser to what happened to be in force at the
 * time, so neither a changed default nor the reader's own browser could reach it again.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, useI18n } from '../src/i18n';

/** The language the console is reading, and the switch a reader would use to leave it. */
function Probe() {
  const { lang, setLang } = useI18n();
  return (
    <button type="button" onClick={() => setLang('zh')}>
      {lang}
    </button>
  );
}

describe('the reading language a visit starts in', () => {
  beforeEach(() => {
    // The suite's shared default, so a test that stores nothing starts with no saved choice.
    window.localStorage.removeItem('omc-lang');
  });

  it('reads the deployment pin without storing it', () => {
    window.__OMCPA_CONFIG__ = { defaultLanguage: 'en' };
    render(<I18nProvider><Probe /></I18nProvider>);

    expect(screen.getByRole('button').textContent).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(window.localStorage.getItem('omc-lang')).toBeNull();
  });

  it('reads the browser language when the deployment pins none', () => {
    vi.stubGlobal('navigator', { languages: ['en-GB', 'en'], language: 'en-GB' });
    render(<I18nProvider><Probe /></I18nProvider>);

    expect(screen.getByRole('button').textContent).toBe('en');
    expect(window.localStorage.getItem('omc-lang')).toBeNull();
  });

  it('stores the language the reader picks', () => {
    window.__OMCPA_CONFIG__ = { defaultLanguage: 'en' };
    render(<I18nProvider><Probe /></I18nProvider>);

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('button').textContent).toBe('zh');
    expect(window.localStorage.getItem('omc-lang')).toBe('zh');
  });
});
