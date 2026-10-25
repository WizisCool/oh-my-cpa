import { act } from '@testing-library/react';
import { expect, it } from 'vitest';
import { fenceRemoteAssets } from '../src/agent/openui/noRemoteAssets';

/**
 * A generated answer is model output, so the assets it names are fenced where it renders: the
 * console's own origin and inline URLs stay, and a remote one loses its source rather than turning
 * the reader's browser into a beacon.
 */
it('fences remote assets in a rendered program and leaves local ones alone', async () => {
  const root = document.createElement('div');
  root.innerHTML = [
    '<img id="remote" src="https://example.com/beacon.png">',
    '<img id="local" src="/api/v1/plugins/demo/logo">',
    '<img id="inline" src="data:image/png;base64,AAAA">',
    '<div id="painted" style="background-image:url(https://example.com/bg.png)"></div>',
    '<img id="mixed" src="/a.png" srcset="/a.png 1x, https://example.com/b.png 2x">',
    '<div id="mixed-paint" style="background-image:url(/local.png),url(https://example.com/c.png)"></div>',
  ].join('');
  document.body.append(root);

  const disconnect = fenceRemoteAssets(root);
  const source = (id: string) => root.querySelector<HTMLElement>(`#${id}`)?.getAttribute('src');
  expect(source('remote')).toBeNull();
  expect(root.querySelector('#remote')?.hasAttribute('data-blocked-asset')).toBe(true);
  expect(source('local')).toBe('/api/v1/plugins/demo/logo');
  expect(source('inline')).toBe('data:image/png;base64,AAAA');
  expect(root.querySelector<HTMLElement>('#painted')?.getAttribute('style')).not.toContain('example.com');
  // One remote candidate is enough to fence the whole declaration: a 2x display would request it.
  expect(root.querySelector('#mixed')?.hasAttribute('srcset')).toBe(false);
  expect(root.querySelector<HTMLElement>('#mixed-paint')?.getAttribute('style')).toContain('url(/local.png)');
  expect(root.querySelector<HTMLElement>('#mixed-paint')?.getAttribute('style')).not.toContain('example.com');

  // A streamed program appends its statements, so the fence has to hold for what arrives later.
  const late = document.createElement('img');
  late.id = 'late';
  late.src = 'https://example.com/late.png';
  await act(async () => {
    root.append(late);
    await Promise.resolve();
  });
  expect(late.getAttribute('src')).toBeNull();
  disconnect();
  document.body.innerHTML = '';
});
