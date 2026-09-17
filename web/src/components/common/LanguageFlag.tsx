import React from 'react';
import cnFlagMarkup from 'country-flag-icons/string/3x2/CN';
import hkFlagMarkup from 'country-flag-icons/string/3x2/HK';
import myFlagMarkup from 'country-flag-icons/string/3x2/MY';
import usFlagMarkup from 'country-flag-icons/string/3x2/US';

/**
 * Flag drawings by country code.
 *
 * Only the flags a registered language asks for are imported. `country-flag-icons`
 * also publishes a React component per country, but each of those re-exports the
 * package's single 331KB module holding every flag at once, which the bundler
 * cannot drop - so the markup strings are imported individually and drawn inline,
 * the same way `BrandArtwork` draws the product mark. Four flags cost about 4KB.
 */
const FLAG_MARKUP: Record<string, string> = {
  CN: cnFlagMarkup,
  HK: hkFlagMarkup,
  MY: myFlagMarkup,
  US: usFlagMarkup,
};

export interface LanguageFlagProps {
  /** ISO country code the language's flag is drawn from. */
  country: string;
  className?: string;
}

/**
 * LanguageFlag draws the flag a language switcher shows beside that language.
 *
 * Decorative by contract: the language's own name is always adjacent in the menu
 * and on the trigger's accessible name, so the flag is never the only thing
 * naming the choice - which is also why it carries no `title` of its own.
 */
export const LanguageFlag: React.FC<LanguageFlagProps> = ({ country, className }) => {
  const markup = FLAG_MARKUP[country];
  if (!markup) return null;
  return (
    <span
      className={className ? `language-flag ${className}` : 'language-flag'}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
};
