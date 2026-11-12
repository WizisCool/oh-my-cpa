import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DesktopOutlined, MoonOutlined, SunOutlined } from '../icons';
import { CountryFlag, LANGUAGE_FLAGS } from './CountryFlag';
import { LANGUAGES, useI18n, useT, type Lang, type MessageKey } from '../../i18n';
import { useTheme } from '../../theme/ThemeContext';
import type { ThemeModePreference } from '../../theme/themePreference';
import { HeaderAction } from './HeaderAction';

const MODE_ICONS: Record<ThemeModePreference, React.ReactNode> = {
  light: <SunOutlined />,
  dark: <MoonOutlined />,
  system: <DesktopOutlined />,
};

const MODE_LABEL_KEYS: Record<ThemeModePreference, MessageKey> = {
  light: 'omc.theme_mode_light',
  dark: 'omc.theme_mode_dark',
  system: 'omc.theme_mode_system',
};

export const PreferenceMenus: React.FC = () => {
  const t = useT();
  const { lang, setLang } = useI18n();
  const { modePreference, cycleModePreference } = useTheme();
  const activeLanguage = LANGUAGES.find((language) => language.id === lang);

  return (
    <>
      <HeaderAction
        label={t('header.theme_state', { mode: t(MODE_LABEL_KEYS[modePreference]) })}
        tooltip={t('header.theme')}
        icon={MODE_ICONS[modePreference]}
        onClick={cycleModePreference}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <HeaderAction
              label={t('header.language')}
              tooltip={`${t('header.language')} · ${activeLanguage ? activeLanguage.name : lang}`}
              icon={activeLanguage ? <CountryFlag markup={LANGUAGE_FLAGS[activeLanguage.country]} /> : undefined}
            >
              <span className="language-trigger-code">{activeLanguage?.code ?? lang}</span>
            </HeaderAction>
          }
        />
        <DropdownMenuContent placement="bottomRight">
          <DropdownMenuRadioGroup
            value={lang}
            onValueChange={(next) => {
              const picked = LANGUAGES.find((language) => language.id === next);
              if (picked) setLang(picked.id as Lang);
            }}
          >
            {LANGUAGES.map((language) => (
              <DropdownMenuRadioItem
                key={language.id}
                value={language.id}
                icon={<CountryFlag markup={LANGUAGE_FLAGS[language.country]} />}
              >
                {language.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};
