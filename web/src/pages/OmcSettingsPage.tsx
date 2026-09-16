import React from 'react';
import { Segmented, Typography } from 'antd';
import { useT, useI18n } from '../i18n';
import { useIsNarrowViewport } from '../hooks/useIsNarrowViewport';
import { useThemeMode } from '../theme/ThemeContext';
import { THEME_PRESETS } from '../theme/themeConfig';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';
import type { TokenNumberStyle } from '../types/tokenDisplay';
import { TOKEN_NUMBER_STYLES } from '../types/tokenDisplay';

const { Title } = Typography;

/**
 * OmcSettingsPage aggregates Oh My CPA's own console settings, separate from
 * CPA's gateway configuration.
 *
 * The page owns the preferences that used to live only in scattered shortcuts:
 * the theme and the language in the header, and the token unit style beside the
 * dashboard's own readouts. Each control writes the same underlying setting its
 * shortcut writes, so the two cannot disagree, and an operator configuring a
 * fresh deployment has one place to look instead of discovering each control
 * where it happens to surface.
 *
 * It carries a single title and no subtitle, and each group is an open list of
 * labelled rows rather than a card: `docs/design.md` §3 allows a subtitle only
 * when it carries live data, and prefers open section lists for settings and
 * management over heavy wrappers. A sentence explaining *why* a switch exists is
 * documentation, not interface.
 *
 * The chart grouping deliberately does **not** appear here. It changes what the
 * two model panels plot, so it belongs on those panels, where the operator
 * reading them is - a second control on a settings page would be a second place
 * to look for one decision.
 *
 * CPA's own configuration (its YAML document) is intentionally not reachable
 * from here: that surface is the config panel's, with its different save
 * semantics. The two pages coexist in the sidebar under "Control".
 */
export const OmcSettingsPage: React.FC = () => {
  const t = useT();
  const { lang, setLang } = useI18n();
  const { themeId, setThemeId } = useThemeMode();
  const { style, setStyle } = useTokenDisplayStyle();
  // A three-option picker cannot fit a phone's card as a row: its track is the sum of its labels,
  // and the items do not wrap, so the third option was painted past the card's edge. Below the
  // console's narrow breakpoint it becomes a vertical list instead, which is the shape that fits.
  const isNarrow = useIsNarrowViewport();

  // The Chinese scale is words - 万, 亿 - so it is offered only to a Chinese
  // console. The option stays visible and disabled rather than hidden: an
  // operator who knows the setting exists should find it and see why it is
  // unavailable, instead of concluding the console dropped it.
  const tokenStyleOptions = TOKEN_NUMBER_STYLES.map((value: TokenNumberStyle) => ({
    value,
    label: value === 'zh' ? t('omc.token_style_zh') : value === 'full' ? t('omc.token_style_full') : t('omc.token_style_en'),
    disabled: value === 'zh' && lang !== 'zh',
  }));

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
          label={t('omc.theme')}
          control={
            <div className="theme-preset-grid" role="group" aria-label={t('omc.theme')}>
              {THEME_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`theme-preset-card${preset.id === themeId ? ' is-active' : ''}`}
                  aria-pressed={preset.id === themeId}
                  onClick={() => setThemeId(preset.id)}
                >
                  <span className="theme-preset-preview" aria-hidden="true">
                    <span style={{ background: preset.palette.bg }} />
                    <span style={{ background: preset.palette.surface }} />
                    <span style={{ background: preset.palette.accent }} />
                    <span style={{ background: preset.palette.success }} />
                  </span>
                  <span className="theme-preset-name">{t(preset.nameKey)}</span>
                  <span className="theme-preset-desc">{t(preset.descriptionKey)}</span>
                </button>
              ))}
            </div>
          }
        />
        <SettingRow
          label={t('omc.language')}
          control={
            <Segmented
              value={lang}
              options={[
                { value: 'zh', label: t('omc.language_zh') },
                { value: 'en', label: t('omc.language_en') },
              ]}
              onChange={(next) => setLang(next as 'zh' | 'en')}
              aria-label={t('omc.language')}
            />
          }
        />
      </div>
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
