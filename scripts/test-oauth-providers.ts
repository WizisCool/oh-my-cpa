import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_OAUTH_IDS,
  BUILTIN_OAUTH_PROVIDERS,
  OAUTH_PROVIDER_PATTERN,
  XAI_CALLBACK_URL,
  lookupOAuthProvider,
  normalizeOAuthFlow,
  normalizeOAuthStatus,
  resolveXaiCallback,
  validateDevinCallback,
} from '../web/src/pages/oauthProviderLogic.ts';

test('Registry: provider ids are unique, routable and consistent with the lookup', () => {
  assert.ok(BUILTIN_OAUTH_PROVIDERS.length > 0, 'registry must not be empty');
  for (const provider of BUILTIN_OAUTH_PROVIDERS) {
    assert.match(provider.id, OAUTH_PROVIDER_PATTERN, `${provider.id} must be a valid CPA provider id`);
    assert.equal(provider.id, provider.id.toLowerCase(), `${provider.id} must be lower case`);
    assert.ok(provider.keyBase.length > 0, `${provider.id} needs an i18n key base`);
    assert.ok(provider.iconId.length > 0, `${provider.id} needs a brand mark`);
    assert.equal(lookupOAuthProvider(provider.id)?.id, provider.id, `${provider.id} must be resolvable`);
    // A redirect flow without callback rules would render no way to submit the
    // paste, which is the only way a remote browser can finish it.
    if (provider.flow === 'manual-callback') {
      assert.ok(provider.callback, `${provider.id} is a redirect flow and needs callback rules`);
      assert.ok(provider.callback?.errorKeys.invalid, `${provider.id} needs an invalid-paste message`);
      assert.ok(provider.callback?.errorKeys.missingState, `${provider.id} needs a missing-state message`);
    } else {
      assert.equal(provider.callback, undefined, `${provider.id} is a device flow and cannot take a paste`);
    }
  }
  assert.equal(BUILTIN_OAUTH_IDS.size, BUILTIN_OAUTH_PROVIDERS.length, 'registry ids must be unique');
});

test('Registry: the Devin and Meta Muse adapters are registered', () => {
  const devin = lookupOAuthProvider('DEViN');
  assert.equal(devin?.flow, 'manual-callback');
  assert.equal(devin?.keyBase, 'devin');
  assert.equal(devin?.requiresExplicitCancel, true, 'Devin holds one attempt at a time');
  assert.equal(typeof devin?.callback?.validate, 'function', 'Devin must judge the pasted redirect');

  const meta = lookupOAuthProvider('meta');
  assert.equal(meta?.flow, 'device');
  assert.equal(meta?.keyBase, 'meta');
  assert.equal(meta?.requiresExplicitCancel, undefined, 'a device flow is restartable by design');

  assert.equal(lookupOAuthProvider('not-a-provider'), undefined);
});

test('normalizeOAuthFlow: unknown labels keep the declared flow', () => {
  assert.equal(normalizeOAuthFlow('device'), 'device');
  assert.equal(normalizeOAuthFlow(' DEVICE '), 'device');
  assert.equal(normalizeOAuthFlow('redirect'), 'manual-callback');
  assert.equal(normalizeOAuthFlow('callback'), 'manual-callback');
  assert.equal(normalizeOAuthFlow(''), undefined);
  assert.equal(normalizeOAuthFlow(undefined), undefined);
  assert.equal(normalizeOAuthFlow('telepathy'), undefined);
});

test('normalizeOAuthStatus: legacy aliases must not become terminal states on their own', () => {
  assert.equal(normalizeOAuthStatus('ok'), 'ok');
  assert.equal(normalizeOAuthStatus('success'), 'ok');
  assert.equal(normalizeOAuthStatus('wait'), 'wait');
  assert.equal(normalizeOAuthStatus('pending'), 'wait');
  assert.equal(normalizeOAuthStatus('error'), 'error');
  assert.equal(normalizeOAuthStatus('failed'), 'error');
  assert.equal(normalizeOAuthStatus(undefined), 'wait');
});

test('validateDevinCallback: accepts a complete redirect for this attempt', () => {
  const state = 'devin-12345';
  assert.equal(
    validateDevinCallback(`http://127.0.0.1:8317/callback?code=abc&state=${state}`, state),
    undefined,
  );
  assert.equal(
    validateDevinCallback(`https://proxy.example.test/devin/callback?state=${state}&code=abc`, state),
    undefined,
  );
  assert.equal(
    validateDevinCallback(`http://127.0.0.1:8317/devin/callback?state=${state}&error=access_denied`, state),
    undefined,
    'a denial is a real callback and has to reach CPA so the session ends',
  );
});

test('validateDevinCallback: refuses anything that cannot belong to this attempt', () => {
  const state = 'devin-12345';
  assert.equal(validateDevinCallback('', state), 'invalid');
  assert.equal(validateDevinCallback('abc123', state), 'invalid', 'a bare code is not enough for Devin');
  assert.equal(validateDevinCallback(`not-a-url?code=abc&state=${state}`, state), 'invalid');
  assert.equal(validateDevinCallback(`http://127.0.0.1:8317/callback?code=abc`, state), 'invalid', 'no state');
  assert.equal(validateDevinCallback(`http://127.0.0.1:8317/callback?state=${state}`, state), 'invalid', 'no code or error');
  assert.equal(
    validateDevinCallback(`http://127.0.0.1:8317/callback?code=abc&state=${state}&state=other`, state),
    'invalid',
    'two states cannot be attributed to one attempt',
  );
  assert.equal(
    validateDevinCallback('http://127.0.0.1:8317/callback?code=abc&state=stale-session', state),
    'state_mismatch',
    'a callback from an earlier attempt must not be submitted against this one',
  );
  assert.equal(
    validateDevinCallback(`http://127.0.0.1:8317/callback?code=abc&state=${state}`, undefined),
    'state_mismatch',
    'without a live state the paste cannot be attributed at all',
  );
});

// Query order is not part of the contract, so comparisons go through the parsed
// parameters rather than the serialized string.
function paramsOf(url: string): Record<string, string> {
  const parsed = new URL(url);
  const out: Record<string, string> = {};
  parsed.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

test('resolveXaiCallback: a real URL is submitted verbatim', () => {
  const url = 'http://127.0.0.1:56121/callback?code=xyz&state=abc';
  assert.equal(resolveXaiCallback(url, 'abc'), url);
});

test('resolveXaiCallback: a bare code is rebuilt against the fixed local callback', () => {
  for (const input of ['code=xyz', 'xyz', 'code: xyz']) {
    const resolved = resolveXaiCallback(input, 'state-1');
    assert.ok(resolved, `${input} must resolve`);
    assert.equal(new URL(resolved!).origin + new URL(resolved!).pathname, XAI_CALLBACK_URL);
    assert.deepEqual(paramsOf(resolved!), { state: 'state-1', code: 'xyz' });
  }
});

test('resolveXaiCallback: a printed code line is not mistaken for a URL', () => {
  // `new URL("Code: xyz")` parses as a `code:` URL, so an unguarded absolute-URL
  // probe submits the displayed line verbatim and loses the code it carries.
  const resolved = resolveXaiCallback('Code: xyz', 'state-1');
  assert.ok(resolved, 'a printed code line must still resolve');
  assert.deepEqual(paramsOf(resolved!), { state: 'state-1', code: 'xyz' });
});

test('resolveXaiCallback: cannot fabricate a callback without the live state', () => {
  assert.equal(resolveXaiCallback('xyz', undefined), null);
  assert.equal(resolveXaiCallback('', 'state-1'), null);
});

test('resolveXaiCallback: a partial callback keeps the state it arrived with', () => {
  assert.deepEqual(paramsOf(resolveXaiCallback('?code=xyz&state=abc', 'state-1')!), { state: 'abc', code: 'xyz' });
  assert.deepEqual(paramsOf(resolveXaiCallback('?error=access_denied&state=abc', 'state-1')!), { state: 'abc', error: 'access_denied' });
  assert.deepEqual(
    paramsOf(resolveXaiCallback('?code=xyz&error=access_denied&error_description=denied&state=abc', 'state-1')!),
    { state: 'abc', code: 'xyz', error: 'access_denied', error_description: 'denied' },
  );
  assert.equal(
    new URL(resolveXaiCallback('?code=xyz', 'state-1')!).searchParams.get('state'),
    'state-1',
    'a callback without its own state borrows the live one',
  );
});
