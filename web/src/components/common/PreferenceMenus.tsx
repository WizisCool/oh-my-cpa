import React from 'react';
import { Button, Dropdown, Tooltip, type MenuProps } from 'antd';
import { DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { LanguageFlag } from './LanguageFlag';
import { LANGUAGES, useI18n, useT } from '../../i18n';
import { useTheme } from '../../theme/ThemeContext';
import type { ThemeModePreference } from '../../theme/themePreference';

/**
 * The mode control's icon, one per state.
 *
 * Three icons rather than two is the whole reason this control can be a button: `system` has to be
 * visible as itself, or an operator who chose it would read the console as having picked a mode for
 * them. The desktop mark is what "the machine decides" looks like next to a sun and a moon.
 */
const MODE_LABEL_KEYS: Record<ThemeModePreference, string> = {
  light: 'omc.theme_mode_light',
  dark: 'omc.theme_mode_dark',
  system: 'omc.theme_mode_system',
};

const MODE_ICONS: Record<ThemeModePreference, React.ReactNode> = {
  light: <SunOutlined />,
  dark: <MoonOutlined />,
  system: <DesktopOutlined />,
};

/**
 * The console's appearance preferences: one mode control, one language menu.
 *
 * **The mode is a cycling control, and the language is a menu.** That asymmetry is deliberate and
 * it is the opposite of what this component used to be. The theme used to be a menu because the
 * console carried six palettes and a toggle could only answer "the other one"; now the palettes
 * belong to the modes and are chosen on the settings page, where they can be previewed in place, so
 * the header's job is the one question a reader actually asks repeatedly - light or dark.
 *
 * The control names itself on hover and says nothing more. It used to spell out the mode in force,
 * the palette behind it and the mode the next click selects, and that sentence was removed: a tooltip
 * that has to describe a control's own state is a tooltip the control is too quiet to do without.
 * What carries the three states instead is the icon - a sun, a moon and a desktop, one per state, so
 * the state in force is visible without hovering - and the settings page's own row, which names all
 * three options in words. The cost is real and is accepted: a reader who has never used the control
 * learns its cycle by clicking it, which is why the cycle starts on the two states people actually
 * want and keeps the system follow as the third step.
 *
 * The language menu is unchanged and stays a menu, because four languages and a reader who may not
 * read the current one is exactly the case a list answers and a cycle does not.
 *
 * Neither owns state: they read and write the same theme and language sources the settings page
 * does. They are shared by the console shell and the authentication gate, so a signed-out visitor
 * picks from the same sources over the same stored preference - the gate renders them where the
 * shell's refresh and sign-out would be meaningless.
 */
export const PreferenceMenus: React.FC = () => {
  const t = useT();
  const { lang, setLang } = useI18n();
  const { modePreference, cycleModePreference } = useTheme();

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
      {/* The tooltip is the control's name; the accessible name additionally states the mode in force,
          because the icon that carries it is decoration to a screen reader - without the state there, all
          three states of the cycle announce identically. */}
      <Tooltip title={t('header.theme')}>
        <Button
          type="text"
          icon={MODE_ICONS[modePreference]}
          aria-label={t('header.theme_state', { mode: t(MODE_LABEL_KEYS[modePreference]) })}
          onClick={cycleModePreference}
        />
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
