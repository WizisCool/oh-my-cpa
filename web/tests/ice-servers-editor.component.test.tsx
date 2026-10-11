import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { IceServersEditor, ICE_UNCHANGED_SENTINEL } from '../src/components/config/IceServersEditor';
import { ALL_CONFIG_FIELDS } from '../src/types/configSchema';

beforeAll(() => {
  // antd's auto-sizing textarea observes its own size; jsdom has no layout.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

const stubT = ((key: string) => key) as never;

const field = ALL_CONFIG_FIELDS.find((entry) => entry.id === 'codexLiveIceServers')!;

function renderEditor(initial: unknown) {
  const onChange = vi.fn();
  const Harness = () => {
    const [current, setCurrent] = React.useState(initial);
    return (
      <IceServersEditor
        field={field}
        value={current}
        t={stubT}
        onChange={(_target, next) => { onChange(next); setCurrent(next); }}
      />
    );
  };
  render(<Harness />);
  return onChange;
}

describe('ice servers editor', () => {
  it('keeps stored secrets as sentinels while urls stay untouched', () => {
    const onChange = renderEditor([
      { urls: ['turn:turn.example.com:3478'], username: ICE_UNCHANGED_SENTINEL, credential: ICE_UNCHANGED_SENTINEL },
    ]);
    // Masked display, no editable secret text.
    expect(screen.getAllByDisplayValue('••••••••')).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('replaces a secret with typed text and clears with an explicit empty', () => {
    const onChange = renderEditor([
      { urls: ['turn:turn.example.com:3478'], username: ICE_UNCHANGED_SENTINEL, credential: ICE_UNCHANGED_SENTINEL },
    ]);
    fireEvent.click(screen.getAllByText('cfg.ice_replace')[0]);
    const input = screen.getByLabelText('cfg.ice_username');
    fireEvent.change(input, { target: { value: 'new-user' } });
    const last = onChange.mock.calls.at(-1)![0] as { username?: string; credential?: string }[];
    expect(last[0].username).toBe('new-user');
    // The untouched credential still carries its sentinel.
    expect(last[0].credential).toBe(ICE_UNCHANGED_SENTINEL);

    fireEvent.click(screen.getAllByText('cfg.ice_clear')[0]);
    const cleared = onChange.mock.calls.at(-1)![0] as { username?: string }[];
    expect(cleared[0].username).toBe('');
  });

  it.each(['username', 'credential'] as const)('keeps %s until nonempty replacement text or explicit clear', (secret) => {
    const onChange = renderEditor([
      { urls: ['turn:turn.example.com:3478'], username: ICE_UNCHANGED_SENTINEL, credential: ICE_UNCHANGED_SENTINEL },
    ]);
    fireEvent.click(screen.getAllByText('cfg.ice_replace')[secret === 'username' ? 0 : 1]);
    const latestSecret = () => (onChange.mock.calls.at(-1)![0] as Record<string, string>[])[0][secret];
    expect(latestSecret()).toBe(ICE_UNCHANGED_SENTINEL);
    expect(screen.queryByText('cfg.ice_reentry_hint')).toBeNull();
    const input = screen.getByLabelText(`cfg.ice_${secret}`);
    fireEvent.change(input, { target: { value: 'replacement' } });
    expect(latestSecret()).toBe('replacement');
    fireEvent.change(screen.getByLabelText(`cfg.ice_${secret}`), { target: { value: '' } });
    expect(latestSecret()).toBe(ICE_UNCHANGED_SENTINEL);
    fireEvent.click(screen.getAllByText('cfg.ice_clear')[secret === 'username' ? 0 : 1]);
    expect(latestSecret()).toBe('');
    fireEvent.click(screen.getAllByText('cfg.ice_replace')[secret === 'username' ? 0 : 1]);
    expect(latestSecret()).toBe(ICE_UNCHANGED_SENTINEL);
  });

  it('discards a typed replacement when Clear is followed by Replace', () => {
    const onChange = renderEditor([
      { urls: ['turn:turn.example.com:3478'], username: ICE_UNCHANGED_SENTINEL },
    ]);
    fireEvent.click(screen.getByText('cfg.ice_replace'));
    fireEvent.change(screen.getByLabelText('cfg.ice_username'), { target: { value: 'discarded-replacement' } });
    fireEvent.click(screen.getByText('cfg.ice_clear'));
    fireEvent.click(screen.getByText('cfg.ice_replace'));
    expect((screen.getByLabelText('cfg.ice_username') as HTMLInputElement).value).toBe('');
    expect(onChange.mock.calls.at(-1)![0][0].username).toBe(ICE_UNCHANGED_SENTINEL);
  });

  it('leaves a new optional secret absent when its draft text is erased', () => {
    const onChange = renderEditor([{ urls: ['stun:example.test'] }]);
    fireEvent.click(screen.getAllByText('cfg.ice_add_secret')[0]);
    fireEvent.change(screen.getByLabelText('cfg.ice_username'), { target: { value: 'draft-user' } });
    fireEvent.change(screen.getByLabelText('cfg.ice_username'), { target: { value: '' } });
    expect(onChange.mock.calls.at(-1)![0][0].username).toBeUndefined();
  });

  it('turns remaining keeps into re-entry decisions when the list shape changes', () => {
    const onChange = renderEditor([
      { urls: ['turn:turn.example.com:3478'], username: ICE_UNCHANGED_SENTINEL, credential: ICE_UNCHANGED_SENTINEL },
    ]);
    fireEvent.click(screen.getByText('cfg.ice_add_server'));
    expect(screen.getByText('cfg.ice_reentry_notice')).toBeTruthy();
    // Keeps became undecided: sentinels stay in the wire value so the server
    // refuses the save instead of mispairing them.
    const last = onChange.mock.calls.at(-1)![0] as { username?: string; credential?: string }[];
    expect(last[0].username).toBe(ICE_UNCHANGED_SENTINEL);
    expect(last).toHaveLength(2);
  });

  it('flags a non-STUN/TURN url', () => {
    renderEditor([{ urls: ['https://example.com'] }]);
    expect(screen.getByText('cfg.ice_bad_url')).toBeTruthy();
  });
});

describe('ice servers editor resync', () => {
  it('settles on reordered keys instead of re-rendering forever', () => {
    // A semantically identical value in another key order must sync once:
    // the old code compared the incoming value against its own normalized
    // emit and called setRows on every render ("Too many re-renders").
    const onChange = renderEditor([
      { credential: ICE_UNCHANGED_SENTINEL, username: ICE_UNCHANGED_SENTINEL, urls: ['turn:example.test'] },
    ]);
    expect(screen.getAllByDisplayValue('••••••••')).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('settles on empty optional fields instead of re-rendering forever', () => {
    const onChange = renderEditor([
      { urls: ['stun:example.test'], username: '', credential: '' },
    ]);
    expect(screen.getByDisplayValue('stun:example.test')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
});
