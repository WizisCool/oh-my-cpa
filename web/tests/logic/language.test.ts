/**
 * The reading language a visit starts in.
 *
 * A deployment pins one with `OMCPA_DEFAULT_LANGUAGE`; a deployment that pins nothing leaves it to
 * the visitor's browser, which is what an upgraded install gets without touching a file. A saved
 * choice still outranks both, and a browser asking for a language the console does not read falls
 * back to the built-in Simplified Chinese.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DEFAULT_LANG, matchBrowserLanguage, resolveInitialLang } from '../../src/i18n/language.ts';

test('a saved choice outranks the deployment pin and the browser', () => {
  assert.equal(resolveInitialLang('ms', 'en', ['zh-CN']), 'ms');
});

test('the deployment pin applies when the browser asks for something else', () => {
  assert.equal(resolveInitialLang(null, 'zh-Hant', ['en-US']), 'zh-Hant');
  assert.equal(resolveInitialLang('', 'en', []), 'en');
});

test('a deployment that pins nothing follows the browser', () => {
  assert.equal(resolveInitialLang(null, undefined, ['en-GB']), 'en');
  assert.equal(resolveInitialLang(null, '', ['ms-MY']), 'ms');
});

test('a browser asking for a language the console does not read reads Simplified Chinese', () => {
  assert.equal(DEFAULT_LANG, 'zh');
  assert.equal(resolveInitialLang(null, undefined, ['ja-JP', 'ko-KR']), 'zh');
  assert.equal(resolveInitialLang(null, undefined, []), 'zh');
});

test('a browser tag is matched by its primary subtag', () => {
  assert.equal(matchBrowserLanguage(['en-GB']), 'en');
  assert.equal(matchBrowserLanguage(['ms-SG']), 'ms');
  assert.equal(matchBrowserLanguage(['ZH-cn']), 'zh');
  assert.equal(matchBrowserLanguage(['ja-JP', 'en-US']), 'en', 'the order of preference decides');
  assert.equal(matchBrowserLanguage(['ja-JP']), undefined);
});

test('Traditional Chinese is the script and its regions, not the whole zh primary subtag', () => {
  for (const tag of ['zh-Hant', 'zh-Hant-TW', 'zh-TW', 'zh-HK', 'zh-MO']) {
    assert.equal(matchBrowserLanguage([tag]), 'zh-Hant', tag);
  }
  for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-SG']) {
    assert.equal(matchBrowserLanguage([tag]), 'zh', tag);
  }
});
