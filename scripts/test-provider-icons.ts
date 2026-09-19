import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CREDENTIAL_PROVIDERS,
  credentialProviderIconId,
  getCredentialProviderMetadata,
} from '../web/src/components/common/providerMetadata.ts';
import { LOBE_ICON_CATALOG, lobeIconSlug } from '../web/src/types/lobeIconCatalog.ts';
import { providerIconId, resolveProviderIcon } from '../web/src/types/providerIconIds.ts';
import { BUILTIN_OAUTH_PROVIDERS } from '../web/src/pages/oauthProviderLogic.ts';
import {
  isRenderableLogoURL,
  pluginOAuthLogoFor,
  pluginOAuthProviderLogos,
} from '../web/src/types/pluginOAuthProviders.ts';
import type { PluginItem } from '../web/src/types/plugin.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Inline artwork, which is the only shape the console renders as a plugin logo. */
const INLINE_LOGO = 'data:image/svg+xml,%3Csvg/%3E';
const catalogIds = new Set(LOBE_ICON_CATALOG.map((item) => item.id));

/** Whether the vendored bundle actually ships the artwork for a mark id. */
function iconAssetExists(iconId: string): boolean {
  const name = `${lobeIconSlug(iconId)}.svg`;
  return fs.existsSync(path.join(root, 'web', 'public', 'lobe-icons', name));
}

test('every built-in OAuth provider reaches a brand mark that ships in the bundle', () => {
  // This is the invariant the OAuth quota and OAuth management tabs depend on: a
  // provider registered in the OAuth registry without a credential-registry row
  // used to render the neutral placeholder while its brand artwork sat unused in
  // the bundle, which reads as "this provider has no identity".
  for (const provider of BUILTIN_OAUTH_PROVIDERS) {
    const iconId = credentialProviderIconId(provider.id);
    assert.notEqual(iconId, '', `${provider.id} must resolve to a brand mark`);
    assert.ok(catalogIds.has(iconId), `${provider.id} resolves to ${iconId}, which the icon catalog does not have`);
    assert.ok(iconAssetExists(iconId), `${provider.id} resolves to ${iconId}, whose artwork is missing from the bundle`);
  }
});

test('the named credential rows carry the mark of the provider they name', () => {
  assert.deepEqual(getCredentialProviderMetadata('devin'), { id: 'devin', label: 'Devin', iconId: 'Devin' });
  assert.deepEqual(getCredentialProviderMetadata('meta'), { id: 'meta', label: 'Meta', iconId: 'Meta' });
  // The CodeBuddy plugin declares `codebuddy` as its provider key; a build that
  // keeps the plugin's own id has to reach the same row.
  assert.equal(getCredentialProviderMetadata('codebuddy').iconId, 'CodeBuddy');
  assert.equal(getCredentialProviderMetadata('workbuddy').iconId, 'CodeBuddy');
  assert.equal(getCredentialProviderMetadata('codebuddy').label, 'Codebuddy');
  // Case and padding are not part of the key.
  assert.equal(getCredentialProviderMetadata('DEViN').iconId, 'Devin');
  assert.equal(getCredentialProviderMetadata('  meta ').iconId, 'Meta');
  assert.equal(getCredentialProviderMetadata('not-a-brand').iconId, '');
});

test('a provider the table has not named still resolves through the icon catalog', () => {
  const iconId = credentialProviderIconId('codebuddy');
  assert.ok(catalogIds.has(iconId));
  assert.equal(providerIconId('codebuddy'), 'CodeBuddy');
  assert.equal(providerIconId('devin'), 'Devin');
});

test('an unknown provider is left unbranded rather than given somebody else\'s mark', () => {
  // `getProviderDefaultIcon` answers OpenAI for anything it cannot place, which is
  // the one answer the credential surfaces must not give: an unnamed provider would
  // be labelled OpenAI.
  assert.equal(resolveProviderIcon('zzz-not-a-brand', 'zzz-not-a-brand'), undefined);
  assert.equal(credentialProviderIconId('zzz-not-a-brand'), '');
  assert.equal(credentialProviderIconId('zzz-not-a-brand', 'zzz-not-a-brand'), '');
});

test('pluginOAuthProviderLogos: a plugin logo is keyed by both the provider key and the plugin id', () => {
  const logos = pluginOAuthProviderLogos([
    {
      id: 'codebuddy',
      name: 'CodeBuddy',
      enabled: true,
      effective_enabled: true,
      supports_oauth: true,
      oauth_provider: 'CodeBuddy',
      logo: INLINE_LOGO,
    },
    {
      id: 'store-plugin-2',
      name: 'Second',
      enabled: true,
      supports_oauth: true,
      oauth_provider: 'second',
      metadata: { logo: 'data:image/svg+xml,%3Csvg/%3E' },
    },
  ]);

  // Spread into a plain object: the map itself has no prototype (the keys come from
  // plugins), which is behaviour this suite pins separately.
  assert.deepEqual({ ...logos }, {
    codebuddy: INLINE_LOGO,
    second: 'data:image/svg+xml,%3Csvg/%3E',
    'store-plugin-2': 'data:image/svg+xml,%3Csvg/%3E',
  });
});

test('pluginOAuthProviderLogos: only an enabled OAuth plugin with a usable logo contributes', () => {
  const base: PluginItem = {
    id: 'example',
    name: 'Example',
    enabled: true,
    supports_oauth: true,
    oauth_provider: 'example',
    logo: INLINE_LOGO,
  };

  // A plugin that cannot hold credentials must not decorate a provider name.
  assert.deepEqual(
    { ...pluginOAuthProviderLogos([{ ...base, effective_enabled: false }]) },
    {},
    'a plugin disabled through the global switch contributes nothing',
  );
  assert.deepEqual({ ...pluginOAuthProviderLogos([{ ...base, enabled: false }]) }, {}, 'the plugin switch is honoured too');
  // A non-OAuth plugin has no provider key of its own.
  assert.deepEqual(
    { ...pluginOAuthProviderLogos([{ ...base, supports_oauth: false, oauth_provider: undefined }]) },
    {},
  );
  // A remote logo, a relative path or an empty value is not artwork this page may
  // load: the console falls back to its own catalog mark for all of them.
  assert.deepEqual({ ...pluginOAuthProviderLogos([{ ...base, logo: 'https://cdn.example.test/example.svg' }]) }, {});
  assert.deepEqual({ ...pluginOAuthProviderLogos([{ ...base, logo: 'icons/example.svg' }]) }, {});
  assert.deepEqual({ ...pluginOAuthProviderLogos([{ ...base, logo: '' }]) }, {});
  assert.deepEqual({ ...pluginOAuthProviderLogos(undefined) }, {});
});

test('isRenderableLogoURL: only inline artwork is a logo this page may load', () => {
  assert.equal(isRenderableLogoURL('data:image/svg+xml,%3Csvg/%3E'), true);
  assert.equal(isRenderableLogoURL('  data:image/png;base64,iVBORw0KGgo=  '), true);
  // Everything else falls back to the catalog mark. A remote URL is refused because the
  // deployment must not depend on a CDN - the Go process inlines a plugin's logo
  // instead - and a relative path would silently resolve against this console's origin.
  assert.equal(isRenderableLogoURL('https://cdn.example.test/a.svg'), false);
  assert.equal(isRenderableLogoURL('http://127.0.0.1:8317/logo.png'), false);
  assert.equal(isRenderableLogoURL('//cdn.example.test/a.svg'), false);
  assert.equal(isRenderableLogoURL('/lobe-icons/devin.svg'), false);
  assert.equal(isRenderableLogoURL('./lobe-icons/devin.svg'), false);
  assert.equal(isRenderableLogoURL('data:text/html,<script/>'), false);
  assert.equal(isRenderableLogoURL('data:image/svg+xml'), false);
  assert.equal(isRenderableLogoURL('javascript:alert(1)'), false);
  assert.equal(isRenderableLogoURL('   '), false);
  assert.equal(isRenderableLogoURL(undefined), false);
});

test('pluginOAuthProviderLogos: a provider key that shadows Object.prototype still carries its logo', () => {
  // The keys come from plugins, so they can collide with an inherited member. A
  // lookup that read `constructor` off the prototype would answer with a function
  // and silently drop the plugin's own mark.
  const logos = pluginOAuthProviderLogos([
    { id: 'shadow', name: 'Shadow', enabled: true, supports_oauth: true, oauth_provider: 'constructor', logo: INLINE_LOGO },
  ]);
  assert.equal(pluginOAuthLogoFor(logos, 'constructor'), INLINE_LOGO);
  assert.equal(pluginOAuthLogoFor(logos, 'toString'), undefined);
  assert.equal(pluginOAuthLogoFor({}, 'constructor'), undefined, 'a plain object must not answer with a prototype member');
});

test('pluginOAuthLogoFor: lookup is case and pad insensitive, and misses are empty', () => {
  const logos = pluginOAuthProviderLogos([
    { id: 'codebuddy', name: 'CodeBuddy', enabled: true, supports_oauth: true, oauth_provider: 'codebuddy', logo: INLINE_LOGO },
  ]);
  assert.equal(pluginOAuthLogoFor(logos, ' CodeBuddy '), INLINE_LOGO);
  assert.equal(pluginOAuthLogoFor(logos, 'devin'), undefined);
  assert.equal(pluginOAuthLogoFor(undefined, 'codebuddy'), undefined);
});

test('the named rows never point at artwork the bundle does not ship', () => {
  for (const [key, meta] of Object.entries(CREDENTIAL_PROVIDERS)) {
    if (!meta.iconId) continue;
    assert.ok(
      catalogIds.has(meta.iconId) && iconAssetExists(meta.iconId),
      `${key} names ${meta.iconId}, which the bundle cannot render`,
    );
  }
});
