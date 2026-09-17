import React from 'react';
import { Button, Dropdown, Tooltip, type MenuProps } from 'antd';
import { BgColorsOutlined } from '@ant-design/icons';
import { LanguageFlag } from './LanguageFlag';
import { ThemeSwatch } from './ThemeSwatch';
import { THEME_PRESETS } from '../../theme/themeConfig';
import { useThemeMode } from '../../theme/ThemeContext';
import { LANGUAGES, useI18n, useT } from '../../i18n';

/**
 * The console's two appearance preferences, as menus.
 *
 * Both are menus rather than toggles. A toggle answers only "the other one", which
 * stopped being the whole answer once the console carried six registered themes; and a
 * language toggle that cycles has to be rewritten the moment another language lands.
 * Each menu lists every registered choice and marks the active one: a preset's palette
 * is drawn beside its name, and a language is shown under its own name in its own
 * script, so the menu stays readable to someone who cannot read the console's current
 * language.
 *
 * Neither owns state: they read and write the same theme and language sources the
 * settings page does. They are shared by the console shell and the authentication gate,
 * so a signed-out visitor picks from the same registry over the same stored preference -
 * the gate renders them where the shell's refresh and sign-out would be meaningless.
 */
export const PreferenceMenus: React.FC = () => {
  const t = useT();
  const { lang, setLang } = useI18n();
  const { themeId, theme, setThemeId } = useThemeMode();

  const themeItems: MenuProps['items'] = THEME_PRESETS.map((preset) => ({
    key: preset.id,
    label: (
      <span className="theme-menu-item">
        <ThemeSwatch palette={preset.palette} className="theme-menu-swatch" />
        <span>{t(preset.nameKey)}</span>
      </span>
    ),
  }));

  const languageItems: MenuProps['items'] = LANGUAGES.map((language) => ({
    key: language.id,
    label: (
      <span className="language-menu-item">
        <LanguageFlag country={language.country} />
        <span>{language.name}</span>
      </span>
    ),
  }));

  const activeLanguage = LANGUAGES.find((language) => language.id === lang);

  return (
    <>
      <Tooltip title={`${t('header.theme')} · ${t(theme.nameKey)}`}>
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: themeItems,
            selectable: true,
            selectedKeys: [themeId],
            onClick: ({ key }) => {
              const picked = THEME_PRESETS.find((preset) => preset.id === key);
              if (picked) setThemeId(picked.id);
            },
          }}
        >
          <Button type="text" icon={<BgColorsOutlined />} aria-label={t('header.theme')} />
        </Dropdown>
      </Tooltip>
      {/* The trigger keeps the language's own code beside its flag inside a fixed
          slot, so switching language never resizes it and never slides the buttons
          an operator is aiming at. */}
      <Tooltip title={`${t('header.language')} · ${activeLanguage ? activeLanguage.name : lang}`}>
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: languageItems,
            selectable: true,
            selectedKeys: [lang],
            onClick: ({ key }) => {
              const picked = LANGUAGES.find((language) => language.id === key);
              if (picked) setLang(picked.id);
            },
          }}
        >
          <Button
            type="text"
            aria-label={t('header.language')}
            icon={activeLanguage ? <LanguageFlag country={activeLanguage.country} /> : undefined}
          >
            <span className="terminal-mono language-trigger-code">{activeLanguage?.code ?? lang}</span>
          </Button>
        </Dropdown>
      </Tooltip>
    </>
  );
};
