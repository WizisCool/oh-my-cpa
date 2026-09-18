import React from 'react';

import {
  emptyCustomPalette,
  getBuiltInPalette,
  resolvePalette,
  type BuiltInPaletteId,
  type CustomPalette,
  type PaletteRef,
  type ResolvedPalette,
  type ThemeCore,
  type ThemeMode,
} from './palette';
import {
  DEFAULT_THEME_PREFERENCES,
  nextModePreference,
  readStoredThemePreferences,
  resolveModePreference,
  sameThemePreferences,
  writeStoredThemePreferences,
  type ThemeModePreference,
  type ThemePreferences,
} from './themePreference';
import { themePaletteCssVariables } from './themeConfig';
import { usePreference } from '../hooks/usePreference';
import { parseThemePreferences, THEME_PREFERENCE_KEY } from './themePreference';

export interface ThemeContextValue {
  /** The preference as stored, without any in-progress edit. */
  preferences: ThemePreferences;
  /** The mode the operator chose, which may be `system`. */
  modePreference: ThemeModePreference;
  /** The mode in force, with `system` resolved against the operating system and any preview applied. */
  themeMode: ThemeMode;
  /** The palette in force, with any in-progress edit applied. Every surface reads this. */
  theme: ResolvedPalette;
  /** What the operating system reports, whether or not the console is following it. */
  systemMode: ThemeMode;
  /** The mode being previewed while another mode's palette is edited, if any. */
  previewMode?: ThemeMode;
  /** The mode whose custom palette editor is open, if any. */
  editingCustomMode?: ThemeMode;
  /** Bumped on every change that has to reach the deployment. */
  revision: number;
  setModePreference: (next: ThemeModePreference) => void;
  cycleModePreference: () => void;
  setPaletteRef: (mode: ThemeMode, ref: PaletteRef) => void;
  openCustomEditor: (mode: ThemeMode) => void;
  closeCustomEditor: () => void;
  updateCustomCore: (mode: ThemeMode, core: ThemeCore) => void;
  /** Re-seed the nine tokens from a different built-in, which is what "start from" means. */
  updateCustomBase: (mode: ThemeMode, base: BuiltInPaletteId) => void;
  resetCustomPalette: (mode: ThemeMode) => void;
  /** Write the in-progress edit into the stored preference, which is what persists it. */
  commitCustomPalette: (mode: ThemeMode) => void;
  /** The palette a mode's custom entry currently shows, draft included. */
  customFor: (mode: ThemeMode) => CustomPalette | undefined;
  /** Adopt the deployment's stored preference; used when this browser has nothing newer. */
  adoptServerPreferences: (preferences: ThemePreferences) => void;
  /** Whether this browser holds a change the deployment has not accepted. */
  isDirty: boolean;
  setDirty: (isDirty: boolean) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

/** The preference this browser had at load, so the first frame is painted before any request. */
function bootstrapPreferences(): { preferences: ThemePreferences; isDirty: boolean } {
  return readStoredThemePreferences() ?? { preferences: DEFAULT_THEME_PREFERENCES, isDirty: false };
}

/**
 * useSystemMode reports what the operating system prefers, and keeps reporting it.
 *
 * The console does not follow this by default - `DEFAULT_THEME_PREFERENCES.mode` is an explicit
 * choice - but it is what "follow the system" resolves against, and it has to keep arriving after
 * the first read, because an operating system switches at dusk.
 */
function useSystemMode(): ThemeMode {
  const [systemMode, setSystemMode] = React.useState<ThemeMode>(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
  );
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const handleChange = (event: MediaQueryListEvent) => setSystemMode(event.matches ? 'light' : 'dark');
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);
  return systemMode;
}

/**
 * ThemeProvider owns the console's theme preference and paints it onto the document.
 *
 * It sits above `ConfigProvider` because Ant Design's tokens are a projection of the resolved
 * palette, and holding the preference here is what lets the header's control, the settings page and
 * the DOM all read one answer. The deployment's copy is a separate concern - see
 * `ThemeServerSync` - so this provider works with no session at all, which is what the sign-in
 * screen needs.
 *
 * An in-progress edit is held as a *draft* beside the stored preference rather than written into
 * it. Dragging a colour picker repaints the whole console on the frame it moves, which is the point
 * of previewing a palette in place, but only a completed change is persisted: the draft is the
 * preview, and the preference is what the operator decided.
 */
export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const bootstrap = React.useMemo(bootstrapPreferences, []);
  const [preferences, setPreferences] = React.useState<ThemePreferences>(bootstrap.preferences);
  const [isDirty, setDirty] = React.useState(bootstrap.isDirty);
  const [revision, setRevision] = React.useState(0);
  const [draft, setDraft] = React.useState<Partial<Record<ThemeMode, CustomPalette>>>({});
  const [editingCustomMode, setEditingCustomMode] = React.useState<ThemeMode | undefined>(undefined);
  const [previewMode, setPreviewMode] = React.useState<ThemeMode | undefined>(undefined);
  const systemMode = useSystemMode();

  const customFor = React.useCallback(
    (mode: ThemeMode) => draft[mode] ?? preferences.custom[mode],
    [draft, preferences.custom],
  );

  // A draft is a preview, so it is applied to the palette the console paints without being stored.
  const themeMode: ThemeMode = previewMode ?? resolveModePreference(preferences.mode, systemMode);
  const theme = React.useMemo(
    () => resolvePalette(themeMode, preferences.palettes[themeMode], customFor(themeMode)),
    [customFor, preferences.palettes, themeMode],
  );

  React.useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.dataset.themeMode = themeMode;
    root.dataset.themePreference = preferences.mode;
    if (previewMode) root.dataset.themePreview = previewMode;
    else delete root.dataset.themePreview;
    root.style.colorScheme = themeMode;
    for (const [name, value] of Object.entries(themePaletteCssVariables(theme.palette))) {
      root.style.setProperty(name, value);
    }
  }, [preferences.mode, previewMode, theme, themeMode]);

  React.useEffect(() => {
    writeStoredThemePreferences(preferences, isDirty);
  }, [preferences, isDirty]);

  /** Every stored change goes through here, so "this browser has something newer" cannot be forgotten. */
  const commit = React.useCallback((mutate: (current: ThemePreferences) => ThemePreferences) => {
    setPreferences((current) => mutate(current));
    setDirty(true);
    setRevision((current) => current + 1);
  }, []);

  const setModePreference = React.useCallback(
    (next: ThemeModePreference) => commit((current) => ({ ...current, mode: next })),
    [commit],
  );

  const cycleModePreference = React.useCallback(() => {
    setModePreference(nextModePreference(preferences.mode));
  }, [preferences.mode, setModePreference]);

  const setPaletteRef = React.useCallback(
    (mode: ThemeMode, ref: PaletteRef) => {
      // Leaving the editor without committing is the rule, not an oversight: only a *completed* change
      // is persisted, so switching to another palette drops the gesture in progress and keeps every
      // change that had already completed.
      setEditingCustomMode(undefined);
      setPreviewMode(undefined);
      commit((current) => ({ ...current, palettes: { ...current.palettes, [mode]: ref } }));
    },
    [commit],
  );

  /**
   * openCustomEditor selects the mode's custom palette and starts previewing that mode.
   *
   * Previewing is what makes an inline editor worth its space: editing the palette of a mode the
   * console is not in would otherwise show nine swatches against the wrong page. The mode
   * *preference* does not move - nothing is switched, only shown - so closing the editor puts the
   * console back where it was.
   */
  const openCustomEditor = React.useCallback(
    (mode: ThemeMode) => {
      setDraft((current) => ({
        ...current,
        [mode]: current[mode] ?? preferences.custom[mode] ?? emptyCustomPalette(mode, preferences.palettes[mode]),
      }));
      commit((current) => ({ ...current, palettes: { ...current.palettes, [mode]: 'custom' } }));
      setEditingCustomMode(mode);
      setPreviewMode(mode);
    },
    [commit, preferences.custom, preferences.palettes],
  );

  /**
   * writeCustomPalette is the one path a custom palette is edited through.
   *
   * Both halves of an edit go through it, and the difference between them is the whole editing model: a
   * *live* write lands in the draft, which the resolution prefers, so the console repaints on the frame
   * the control moved; a *commit* writes the same palette into the stored preference and drops the
   * draft, so the gesture that produced it is the one request it costs.
   *
   * The update is a function rather than a finished palette so the two halves cannot disagree: what is
   * committed is computed from the draft the live write just produced, which is what stops a completion
   * from persisting the palette as it stood *before* the gesture that ended it.
   */
  const writeCustomPalette = React.useCallback(
    (mode: ThemeMode, update: (current: CustomPalette) => CustomPalette, commit: boolean) => {
      const current = draft[mode] ?? preferences.custom[mode] ?? emptyCustomPalette(mode, preferences.palettes[mode]);
      const next = update(current);
      if (commit) {
        setPreferences((stored) => ({ ...stored, custom: { ...stored.custom, [mode]: next } }));
        setDirty(true);
        setRevision((count) => count + 1);
        setDraft((existing) => {
          const { [mode]: _committed, ...rest } = existing;
          return rest;
        });
        return;
      }
      setDraft((existing) => ({ ...existing, [mode]: next }));
    },
    [draft, preferences.custom, preferences.palettes],
  );

  const updateCustomCore = React.useCallback(
    (mode: ThemeMode, core: ThemeCore) => {
      writeCustomPalette(mode, (current) => ({ ...current, core }), false);
    },
    [writeCustomPalette],
  );

  /**
   * updateCustomBase re-seeds the tokens from another registered palette, and persists it.
   *
   * Committed rather than left pending, because choosing a starting palette is a complete decision
   * rather than a step within one: it is clicked once and then read, not dragged.
   */
  const updateCustomBase = React.useCallback(
    (mode: ThemeMode, base: BuiltInPaletteId) => {
      writeCustomPalette(mode, (current) => ({ ...current, base, core: { ...getBuiltInPalette(base).core } }), true);
    },
    [writeCustomPalette],
  );

  /**
   * Reset goes back to the palette the edit started from, which is why the base is stored.
   *
   * It persists as it resets: a reset that only moved the draft would leave the console showing the
   * starting palette while the deployment still held the abandoned one.
   */
  const resetCustomPalette = React.useCallback(
    (mode: ThemeMode) => {
      writeCustomPalette(mode, (current) => ({ ...current, core: { ...getBuiltInPalette(current.base).core } }), true);
    },
    [writeCustomPalette],
  );

  const commitCustomPalette = React.useCallback(
    (mode: ThemeMode) => {
      writeCustomPalette(mode, (current) => current, true);
    },
    [writeCustomPalette],
  );

  // Read through a ref by `leaveCustomEditor` so that leaving stays a stable callback: the editor is
  // open while every keystroke in it re-renders, and a callback that changed identity on each of those
  // would re-render every consumer of this context on each of them.
  const commitCustomPaletteRef = React.useRef(commitCustomPalette);
  commitCustomPaletteRef.current = commitCustomPalette;

  /**
   * leaveCustomEditor commits whatever is pending and stops previewing.
   *
   * Every way out of the editor goes through it, because opening the editor is what selects the custom
   * palette: an edit that was dropped on the way out would leave the stored document saying "this mode
   * uses the custom palette" with no custom palette in it, which renders as the mode's first registered
   * palette under a card that claims otherwise. Committing on the way out means the card and the console
   * agree whichever route the operator took - including clicking a different palette, which keeps the
   * edit for next time rather than discarding it.
   */
  const leaveCustomEditor = React.useCallback(() => {
    if (editingCustomMode) commitCustomPaletteRef.current(editingCustomMode);
    setEditingCustomMode(undefined);
    setPreviewMode(undefined);
  }, [editingCustomMode]);

  const adoptServerPreferences = React.useCallback((stored: ThemePreferences) => {
    setPreferences((current) => (sameThemePreferences(current, stored) ? current : stored));
  }, []);

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      preferences,
      modePreference: preferences.mode,
      themeMode,
      theme,
      systemMode,
      previewMode,
      editingCustomMode,
      revision,
      setModePreference,
      cycleModePreference,
      setPaletteRef,
      openCustomEditor,
      closeCustomEditor: leaveCustomEditor,
      updateCustomCore,
      updateCustomBase,
      resetCustomPalette,
      commitCustomPalette,
      customFor,
      adoptServerPreferences,
      isDirty,
      setDirty,
    }),
    [
      adoptServerPreferences, commitCustomPalette, customFor, cycleModePreference, editingCustomMode, isDirty,
      leaveCustomEditor, openCustomEditor, preferences, previewMode, resetCustomPalette, revision, setDirty,
      setModePreference, setPaletteRef, systemMode, theme, themeMode, updateCustomBase, updateCustomCore,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextValue {
  const value = React.useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}

/**
 * ThemeServerSync carries the theme preference between this browser and the deployment.
 *
 * The rule is **the newer writer wins, and this browser's own unsaved change counts as newer than
 * whatever the deployment still holds** - see `docs/adr/0011-theme-modes-and-derived-palettes.md`.
 * It has to work that way because the preference endpoint needs a session and the sign-in screen
 * does not have one: an operator who switches to light before signing in has already expressed a
 * choice, and adopting the deployment's older value on arrival would silently undo it. The cost is
 * stated rather than hidden: two browsers that both hold an unsaved change settle on whichever
 * pushes last, because neither localStorage nor the preference table carries a version to compare.
 *
 * It lives here rather than in `ThemeProvider` because `usePreference` reports failures through Ant
 * Design's message API, which only exists below `App` - and the provider has to sit above
 * `ConfigProvider`, since Ant Design's tokens are projected from the palette it resolves.
 */
export const ThemeServerSync: React.FC = () => {
  const { preferences, revision, setDirty, adoptServerPreferences, isDirty } = useTheme();
  // The preference as it stood before this session changed anything. It is both the value the
  // request falls back to when the deployment has nothing stored, and the answer to "did this
  // browser already have something newer than the deployment?" - which is the whole conflict rule.
  const bootstrap = React.useMemo(bootstrapPreferences, []);
  const { value: stored, ready, set } = usePreference<ThemePreferences>(
    THEME_PREFERENCE_KEY,
    bootstrap.preferences,
    parseThemePreferences,
  );
  const settled = React.useRef(false);
  const pushedRevision = React.useRef<number | undefined>(undefined);
  const isBlocked = React.useRef(false);
  const latest = React.useRef(preferences);
  latest.current = preferences;

  React.useEffect(() => {
    if (!ready) return;
    if (!settled.current) {
      settled.current = true;
      // Recorded whether or not this settles by pushing. Nothing before this point is a change this session
      // made, so treating the settling revision as already sent is what stops the effect from pushing a
      // document the deployment already holds - which is exactly what a StrictMode remount would do, since
      // it re-runs effects while these refs survive.
      pushedRevision.current = revision;
      if (bootstrap.isDirty) {
        // `latest` rather than the bootstrap document: a change made while this request was in flight is
        // part of this browser's newer opinion, and pushing the value the session opened with would send
        // the older document and then read the newer local one as a refused write.
        set(latest.current);
        return;
      }
      if (!sameThemePreferences(stored, latest.current)) adoptServerPreferences(stored);
      return;
    }
    if (revision === pushedRevision.current) return;
    // A new local change is a new attempt: the previous one may have been refused by a database that is
    // back, and suppressing every later push for the rest of the session would leave an operator editing
    // a console whose changes never leave the browser. Each attempt can cost one error message, which is
    // the operator's only sign that the deployment is not keeping up.
    isBlocked.current = false;
    pushedRevision.current = revision;
    set(latest.current);
  }, [adoptServerPreferences, bootstrap.isDirty, ready, revision, set, stored]);

  React.useEffect(() => {
    if (!ready || !settled.current) return;
    if (sameThemePreferences(stored, latest.current)) {
      // The deployment holds what this browser holds, so there is nothing left to push. Clearing the
      // flag here, and only here, is what stops a stale `dirty` from overwriting the deployment's
      // newer value at the next sign-in.
      isBlocked.current = false;
      if (isDirty) setDirty(false);
      return;
    }
    if (revision === pushedRevision.current) {
      // We pushed this revision and the deployment's copy still differs: the write was refused and
      // `usePreference` has already put the cache back. Retrying it here would be a request loop against
      // a refusing server, so this revision is not retried - the flag stays set so the next load pushes
      // this browser's choice again, and the next local change pushes on its own account.
      isBlocked.current = true;
      if (!isDirty) setDirty(true);
    }
  }, [isDirty, ready, revision, setDirty, stored]);

  return null;
};
