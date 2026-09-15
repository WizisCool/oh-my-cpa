import React from 'react';
import { Card, Segmented, Typography } from 'antd';
import { useT, useI18n } from '../i18n';
import { useThemeMode } from '../theme/ThemeContext';
import { useTokenDisplayStyle } from '../types/tokenDisplayContext';
import type { ModelChartView, TokenNumberStyle } from '../types/tokenDisplay';
import { TOKEN_NUMBER_STYLES, MODEL_CHART_VIEWS } from '../types/tokenDisplay';

const { Text, Title } = Typography;

interface SettingRowProps {
  label: string;
  description: string;
  control: React.ReactNode;
}

/**
 * SettingRow is one labelled setting: name and explanation on the left, the
 * control on the right.
 *
 * Every control on this page commits on interaction - a Segmented click or a
 * Switch flip is the whole save - so there is no footer bar and no dirty
 * state to manage. That is the deliberate difference from the config panel:
 * these settings describe how the console reads data, and none of them can
 * leave the deployment in a broken intermediate state, which is the risk the
 * config panel's revision-guarded save flow exists to manage.
 */
const SettingRow: React.FC<SettingRowProps> = ({ label, description, control }) => (
  <div className="omc-setting-row">
    <div className="omc-setting-copy">
      <span className="omc-setting-label">{label}</span>
      <Text type="secondary" className="omc-setting-desc">{description}</Text>
    </div>
    <div className="omc-setting-control">{control}</div>
  </div>
);

/**
 * OmcSettingsPage aggregates Oh My CPA's own settings, separate from CPA's
 * gateway configuration.
 *
 * The page owns the console-side preferences that used to live only in
 * scattered shortcuts: the theme and the language in the header, the token
 * unit style and the model panels' default view beside the panels themselves.
 * Gathering them is not a restatement - each control here writes the same
 * underlying setting its shortcut writes, so they cannot disagree, and an
 * operator configuring a fresh deployment has one place to look instead of
 * discovering each control where it happens to surface.
 *
 * CPA's own configuration (its YAML document) is intentionally not reachable
 * from here: that surface is the config panel's, with its different save
 * semantics. The two pages coexist in the sidebar under "Control".
 */
export const OmcSettingsPage: React.FC = () => {
  const t = useT();
  const { lang, setLang } = useI18n();
  const { themeMode, toggleTheme } = useThemeMode();
  const { style, modelView, setStyle, setModelView } = useTokenDisplayStyle();

  const tokenStyleOptions = TOKEN_NUMBER_STYLES.map((value: TokenNumberStyle) => ({
    value,
    label: value === 'zh' ? t('omc.token_style_zh') : t('omc.token_style_en'),
  }));
  const modelViewOptions = MODEL_CHART_VIEWS.map((value: ModelChartView) => ({
    value,
    label: value === 'call' ? t('omc.model_view_call') : t('omc.model_view_model'),
  }));

  return (
    <div className="terminal-page omc-settings-page">
      <div className="terminal-page-head">
        <div>
          <Title level={2} className="terminal-title">{t('omc.title')}</Title>
          <Text type="secondary" className="terminal-subtitle">{t('omc.subtitle')}</Text>
        </div>
      </div>

      <Card className="omc-settings-card" styles={{ body: { padding: 20 } }}>
        <div className="section-heading">
          <h2>{t('omc.section_display')}</h2>
          <Text type="secondary">{t('omc.section_display_desc')}</Text>
        </div>
        <SettingRow
          label={t('omc.token_style')}
          description={t('omc.token_style_desc')}
          control={
            <SegmentedControl
              value={style}
              options={tokenStyleOptions}
              onChange={(next) => setStyle(next as TokenNumberStyle)}
              ariaLabel={t('omc.token_style')}
            />
          }
        />
      </Card>

      <Card className="omc-settings-card" styles={{ body: { padding: 20 } }}>
        <div className="section-heading">
          <h2>{t('omc.section_charts')}</h2>
          <Text type="secondary">{t('omc.section_charts_desc')}</Text>
        </div>
        <SettingRow
          label={t('omc.model_view')}
          description={t('omc.model_view_desc')}
          control={
            <SegmentedControl
              value={modelView}
              options={modelViewOptions}
              onChange={(next) => setModelView(next as ModelChartView)}
              ariaLabel={t('omc.model_view')}
            />
          }
        />
        <p className="empty-copy omc-note">{t('omc.call_view_note')}</p>
      </Card>

      <Card className="omc-settings-card" styles={{ body: { padding: 20 } }}>
        <div className="section-heading">
          <h2>{t('omc.section_appearance')}</h2>
          <Text type="secondary">{t('omc.section_appearance_desc')}</Text>
        </div>
        <SettingRow
          label={t('omc.theme')}
          description={t('omc.theme_desc')}
          control={
            <SegmentedControl
              value={themeMode}
              options={[
                { value: 'dark', label: t('omc.theme_dark') },
                { value: 'light', label: t('omc.theme_light') },
              ]}
              onChange={(next) => {
                if (next !== themeMode) toggleTheme();
              }}
              ariaLabel={t('omc.theme')}
            />
          }
        />
        <SettingRow
          label={t('omc.language')}
          description={t('omc.language_desc')}
          control={
            <SegmentedControl
              value={lang}
              options={[
                { value: 'zh', label: t('omc.language_zh') },
                { value: 'en', label: t('omc.language_en') },
              ]}
              onChange={(next) => setLang(next as 'zh' | 'en')}
              ariaLabel={t('omc.language')}
            />
          }
        />
      </Card>
    </div>
  );
};

/**
 * SegmentedControl is the page's only control shape.
 *
 * A select would imply more options than these settings ever have, and a
 * switch cannot name its alternatives. The generic wrapper exists so each row
 * states its own options and none of them restyles antd's Segmented
 * independently.
 */
const SegmentedControl: React.FC<{
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  ariaLabel: string;
}> = ({ value, options, onChange, ariaLabel }) => (
  <Segmented
    value={value}
    options={options}
    onChange={(next) => onChange(String(next))}
    aria-label={ariaLabel}
  />
);
