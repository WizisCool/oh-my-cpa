import React from 'react';
import { Button, ColorPicker, Segmented, Select, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { isChineseLanguage, useT, useI18n, LANGUAGES } from '../i18n';
import { useIsNarrowViewport } from '../hooks/useIsNarrowViewport';
import { useTheme } from '../theme/ThemeContext';
import {
  CONTRAST_FLOORS,
  CORE_TOKEN_CONTRAST_ROLES,
  CORE_TOKEN_KEYS,
  builtInPalettesForMode,
  derivePalette,
  resolvedBuiltInPalette,
  type ContrastRole,
  type ThemeCore,
  type ThemeMode,
} from '../theme/palette';
import { contrastRatio } from '../theme/colorMath';
import { THEME_MODE_PREFERENCES, resolveModePreference, type ThemeModePreference } from '../theme/themePreference';
import { ThemeSwatch } from '../components/common/ThemeSwatch';
import { LanguageFlag } from '../components/common/LanguageFlag';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';
import type { TokenNumberStyle } from '../types/tokenDisplay';
import { TOKEN_NUMBER_STYLES } from '../types/tokenDisplay';

const { Title } = Typography;

const MODE_LABEL_KEYS: Record<ThemeModePreference, string> = {
  light: 'omc.theme_mode_light',
  dark: 'omc.theme_mode_dark',
  system: 'omc.theme_mode_system',
};

const TOKEN_LABEL_KEYS: Record<keyof ThemeCore, string> = {
  bg: 'omc.token_bg',
  surface: 'omc.token_surface',
  elevated: 'omc.token_elevated',
  fg: 'omc.token_fg',
  fg2: 'omc.token_fg2',
  muted: 'omc.token_muted',
  meta: 'omc.token_meta',
  border: 'omc.token_border',
  accent: 'omc.token_accent',
};

const ROLE_LABEL_KEYS: Record<ContrastRole, string> = {
  text: 'omc.contrast_role_text',
  hint: 'omc.contrast_role_hint',
  quiet: 'omc.contrast_role_quiet',
  layer: 'omc.contrast_role_layer',
};

/**
 * OmcSettingsPage aggregates Oh My CPA's own console settings, separate from
 * CPA's gateway configuration.
 *
 * The page owns the preferences that used to live only in scattered shortcuts: the theme mode and
 * the two palettes behind it, the language the header's menu switches, and the token unit style
 * beside the dashboard's own readouts. Each control writes the same underlying setting its shortcut
 * writes, so the two cannot disagree, and an operator configuring a fresh deployment has one place
 * to look instead of discovering each control where it happens to surface.
 *
 * **The appearance group is a mode and two palettes, not a list of palettes.** The header's control
 * answers "light or dark" and nothing else; which palette each of those two modes uses is a
 * considered choice an operator makes once, and it is made here where each candidate can be
 * previewed against the whole page. The two groups are always both present, whichever mode is in
 * force, because "the light palette" is a setting about light mode rather than a setting only
 * available *in* light mode - and choosing one here does not move the console, since a click that
 * changed two settings would be a click whose second effect the operator did not ask for.
 *
 * The editor is inline rather than in a drawer or a dialog for one reason: a palette *is* the page
 * around it. Nine swatches in a floating panel can be judged against each other and against nothing
 * else, while an inline editor over the console shows the side rail, the tables and the charts
 * repainting as the accent moves. Editing the mode the console is not in temporarily previews that
 * mode for the same reason, and says so while it does.
 *
 * It carries a single title and no subtitle, and each group is an open list of labelled rows rather
 * than a card: `docs/design.md` §3 allows a subtitle only when it carries live data, and prefers
 * open section lists for settings and management over heavy wrappers. A sentence explaining *why* a
 * switch exists is documentation, not interface.
 *
 * The chart grouping deliberately does **not** appear here. It changes what the two model panels
 * plot, so it belongs on those panels, where the operator reading them is - a second control on a
 * settings page would be a second place to look for one decision.
 *
 * CPA's own configuration (its YAML document) is intentionally not reachable from here: that
 * surface is the config panel's, with its different save semantics. The two pages coexist in the
 * sidebar under "Control".
 */
export const OmcSettingsPage: React.FC = () => {
  const t = useT();
  const { lang, setLang } = useI18n();
  const { style, setStyle } = useTokenDisplayStyle();
  const { modePreference, setModePreference, systemMode, previewMode, themeMode } = useTheme();
  // A multi-option picker cannot fit a phone's card as a row: its track is the sum of its labels,
  // and the items do not wrap, so later options paint past the card's edge. Below the console's
  // narrow breakpoint it becomes a vertical list instead, which is the shape that fits.
  const isNarrow = useIsNarrowViewport();

  // The Chinese scale is words - 万, 亿 - so it is offered only to a Chinese
  // console. The option stays visible and disabled rather than hidden: an
  // operator who knows the setting exists should find it and see why it is
  // unavailable, instead of concluding the console dropped it.
  const tokenStyleOptions = TOKEN_NUMBER_STYLES.map((value: TokenNumberStyle) => ({
    value,
    label: value === 'zh' ? t('omc.token_style_zh') : value === 'full' ? t('omc.token_style_full') : t('omc.token_style_en'),
    disabled: value === 'zh' && !isChineseLanguage(lang),
  }));

  // The preview note appears only when the console is showing a mode other than the one in force.
  // Previewing the mode already in force is not worth announcing: nothing moved.
  const isPreviewingOtherMode = previewMode !== undefined && previewMode !== resolveModePreference(modePreference, systemMode);

  return (
    <div className="terminal-page omc-settings-page">
      <div className="terminal-page-head">
        <Title level={2} className="terminal-title">{t('omc.title')}</Title>
      </div>

      <div className="settings-group omc-settings-group">
        <div className="settings-group-head">
          <h3 className="settings-group-title">{t('omc.section_display')}</h3>
        </div>
        <SettingRow
          label={t('omc.token_style')}
          description={t('omc.token_style_desc')}
          control={
            <Segmented
              value={style}
              options={tokenStyleOptions}
              onChange={(next) => setStyle(next as TokenNumberStyle)}
              aria-label={t('omc.token_style')}
              vertical={isNarrow}
              block={isNarrow}
            />
          }
        />
      </div>

      <div className="settings-group omc-settings-group">
        <div className="settings-group-head">
          <h3 className="settings-group-title">{t('omc.section_appearance')}</h3>
        </div>
        <SettingRow
          label={t('omc.theme_mode')}
          description={t(
            modePreference === 'system' ? 'omc.theme_mode_desc_system' : 'omc.theme_mode_desc',
            { mode: t(MODE_LABEL_KEYS[themeMode]) },
          )}
          control={
            <Segmented
              value={modePreference}
              options={THEME_MODE_PREFERENCES.map((value) => ({ value, label: t(MODE_LABEL_KEYS[value]) }))}
              onChange={(next) => setModePreference(next as ThemeModePreference)}
              aria-label={t('omc.theme_mode')}
              vertical={isNarrow}
              block={isNarrow}
            />
          }
        />
        {isPreviewingOtherMode && (
          <p className="palette-preview-note" role="status">
            {t('omc.palette_previewing', { mode: t(MODE_LABEL_KEYS[previewMode as ThemeMode]) })}
          </p>
        )}
        <PaletteSetting mode="light" />
        <PaletteSetting mode="dark" />
        <SettingRow
          label={t('omc.language')}
          control={
            <Segmented
              value={lang}
              options={LANGUAGES.map((language) => ({
                value: language.id,
                label: (
                  <span className="language-menu-item">
                    <LanguageFlag country={language.country} />
                    <span>{language.name}</span>
                  </span>
                ),
              }))}
              onChange={(next) => {
                const picked = LANGUAGES.find((language) => language.id === next);
                if (picked) setLang(picked.id);
              }}
              aria-label={t('omc.language')}
              vertical={isNarrow}
              block={isNarrow}
              // Each option carries its language's endonym rather than a translated name: a
              // reader who cannot read the console's current language has to be able to find
              // their own here. The endonym is also what keeps this row inside its card on a
              // phone - a translated "Simplified Chinese" measured wider than the track the
              // narrow-layout rule hands this picker.
            />
          }
        />
      </div>
    </div>
  );
};

/**
 * PaletteSetting is one mode's palette row, plus its editor directly beneath it.
 *
 * The editor is a sibling of the row rather than part of its control column, because the row hands
 * its control a column sized for a segmented picker and nine token rows with colour pickers need the
 * width of the card. Keeping the chooser inside the row is also what keeps the existing
 * "every settings control fits the column it is given" guarantee measurable.
 */
const PaletteSetting: React.FC<{ mode: ThemeMode }> = ({ mode }) => {
  const t = useT();
  const { editingCustomMode } = useTheme();
  return (
    <>
      <SettingRow
        label={t(mode === 'light' ? 'omc.palette_light' : 'omc.palette_dark')}
        control={<PaletteChooser mode={mode} />}
      />
      {editingCustomMode === mode && <CustomPaletteEditor mode={mode} />}
    </>
  );
};

/**
 * PaletteChooser lists the palettes one mode offers, and records the choice.
 *
 * A card that belongs to the mode the console is not in still records: the click says "light mode
 * uses Sandstone", not "show me Sandstone now". The mode control is the row above, and it is the one
 * that moves the console.
 */
const PaletteChooser: React.FC<{ mode: ThemeMode }> = ({ mode }) => {
  const t = useT();
  const { preferences, setPaletteRef, openCustomEditor, customFor } = useTheme();
  const selected = preferences.palettes[mode];
  const custom = customFor(mode);
  const groupLabel = t(mode === 'light' ? 'omc.palette_light' : 'omc.palette_dark');

  return (
    <div className="theme-preset-grid" role="group" aria-label={groupLabel}>
      {builtInPalettesForMode(mode).map((definition) => {
        const resolved = resolvedBuiltInPalette(definition.id);
        const isActive = selected === definition.id;
        return (
          <button
            key={definition.id}
            type="button"
            className={`theme-preset-card${isActive ? ' is-active' : ''}`}
            aria-pressed={isActive}
            onClick={() => setPaletteRef(mode, definition.id)}
          >
            <ThemeSwatch palette={resolved.palette} className="theme-preset-preview" />
            <span className="theme-preset-name">{t(definition.nameKey)}</span>
            <span className="theme-preset-desc">{t(definition.descriptionKey)}</span>
          </button>
        );
      })}
      <button
        type="button"
        className={`theme-preset-card is-custom${selected === 'custom' ? ' is-active' : ''}${custom ? '' : ' is-empty'}`}
        aria-pressed={selected === 'custom'}
        onClick={() => openCustomEditor(mode)}
      >
        {custom ? (
          <ThemeSwatch palette={derivePalette(mode, custom.core)} className="theme-preset-preview" />
        ) : (
          <span className="theme-preset-preview theme-preset-blank" aria-hidden="true"><PlusOutlined /></span>
        )}
        <span className="theme-preset-name">{t('omc.palette_custom')}</span>
        <span className="theme-preset-desc">{t('omc.palette_custom_desc')}</span>
      </button>
    </div>
  );
};

/**
 * CustomPaletteEditor is the nine authored tokens, live.
 *
 * Dragging a colour repaints the console on that frame and writes nothing; the change reaches the
 * deployment when the picker reports the drag finished. That is the split that makes an in-place
 * editor worth having without turning one gesture into forty requests, and it means an abandoned
 * drag never leaves a half-chosen palette stored anywhere.
 */
const CustomPaletteEditor: React.FC<{ mode: ThemeMode }> = ({ mode }) => {
  const t = useT();
  const {
    customFor,
    updateCustomCore,
    updateCustomBase,
    resetCustomPalette,
    commitCustomPalette,
    closeCustomEditor,
  } = useTheme();
  const custom = customFor(mode);
  if (!custom) return null;

  const setToken = (key: keyof ThemeCore, value: string) => {
    updateCustomCore(mode, { ...custom.core, [key]: value });
  };

  return (
    <div className="palette-editor" role="group" aria-label={t('omc.palette_editor_label', { mode: t(mode === 'light' ? 'omc.palette_light' : 'omc.palette_dark') })}>
      <div className="palette-editor-head">
        <label className="palette-editor-field">
          <span className="palette-editor-field-label">{t('omc.palette_base')}</span>
          <Select
            value={custom.base}
            onChange={(next) => updateCustomBase(mode, next)}
            // Only the palettes of this mode. A palette belongs to a mode - its nine tokens are chosen for
            // that mode's surfaces and its text ladder points one way - so offering the other mode's
            // palettes here would let an operator start a light palette from a dark one and then have to
            // author every token back out of it, which is not what "start from" is for.
            options={builtInPalettesForMode(mode).map((definition) => ({
              value: definition.id,
              label: t(definition.nameKey),
            }))}
            aria-label={t('omc.palette_base')}
          />
        </label>
        <div className="palette-editor-actions">
          <Button onClick={() => resetCustomPalette(mode)}>
            {t('omc.palette_reset')}
          </Button>
          <Button type="primary" onClick={closeCustomEditor}>{t('omc.palette_done')}</Button>
        </div>
      </div>
      <div className="palette-token-list">
        {CORE_TOKEN_KEYS.map((key) => (
          <PaletteTokenRow
            key={key}
            tokenKey={key}
            value={custom.core[key]}
            page={custom.core.bg}
            onChange={(value) => setToken(key, value)}
            onCommit={() => commitCustomPalette(mode)}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * PaletteTokenRow is one authored token: its name, its colour, and what it measures against the page.
 *
 * The number is judged against the token's *role*, not one threshold. `fg` is body text and answers
 * to 4.5:1; `muted` is the hint step and `meta` the footnote step below it; the surface and border
 * steps are layers and have no text floor at all. One threshold would leave two of every correct
 * palette's rows permanently marked, and an indicator that is always lit is an indicator nobody
 * reads. The role and its floor travel in the tooltip, so the marker never has to be memorised.
 */
const PaletteTokenRow: React.FC<{
  tokenKey: keyof ThemeCore;
  value: string;
  page: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}> = ({ tokenKey, value, page, onChange, onCommit }) => {
  const t = useT();
  const role = CORE_TOKEN_CONTRAST_ROLES[tokenKey];
  const floor = CONTRAST_FLOORS[role];
  const ratio = contrastRatio(value, page);
  const status = floor === undefined ? 'layer' : ratio >= floor ? 'ok' : 'low';
  return (
    <div className="palette-token-row">
      <span className="palette-token-name">{t(TOKEN_LABEL_KEYS[tokenKey])}</span>
      <ColorPicker
        value={value}
        disabledAlpha
        // Named for a screen reader: the row's label is a sibling span, so without this the control
        // announces a hex value and nothing about which token it belongs to. Ant Design forwards `aria-*`
        // to the trigger, which is what makes the name land on the focusable element rather than the field.
        aria-label={t(TOKEN_LABEL_KEYS[tokenKey])}
        showText={(color) => color.toHexString()}
        onChange={(color) => onChange(color.toHexString())}
        onChangeComplete={() => onCommit()}
      />
      <span
        className={`terminal-mono palette-token-ratio is-${status}`}
        title={
          floor === undefined
            ? t('omc.contrast_layer')
            : t('omc.contrast_floor', { floor: String(floor), role: t(ROLE_LABEL_KEYS[role]) })
        }
      >
        {status === 'ok' ? '✓' : status === 'low' ? '⚠' : '·'} {ratio.toFixed(1)}:1
      </span>
    </div>
  );
};

/**
 * SettingRow is one labelled setting: name on the left, control on the right.
 *
 * The description is optional because most of these settings name themselves -
 * "Theme" needs no sentence - and copy that only restates the label is the
 * decorative text `docs/design.md` §3 rules out. A description survives only
 * where it states a fact the label cannot: what a unit style changes, or what
 * an abbreviated number is rounded from.
 */
const SettingRow: React.FC<{ label: string; description?: string; control: React.ReactNode }> = ({
  label,
  description,
  control,
}) => (
  <div className="settings-toggle-row">
    <div className="settings-toggle-info">
      <div className="settings-toggle-title">{label}</div>
      {description && <div className="settings-toggle-desc">{description}</div>}
    </div>
    <div className="settings-toggle-control">{control}</div>
  </div>
);
