import React from 'react';
import cnFlagMarkup from 'country-flag-icons/string/3x2/CN';
import hkFlagMarkup from 'country-flag-icons/string/3x2/HK';
import myFlagMarkup from 'country-flag-icons/string/3x2/MY';
import usFlagMarkup from 'country-flag-icons/string/3x2/US';
import type { LANGUAGES } from '../../i18n/language';

/**
 * The flags the shell's language switcher draws, keyed by each registered language's country so
 * the compiler names a missing one.
 *
 * `country-flag-icons` also publishes a React component per country, but each of those re-exports
 * the package's single 331KB module holding every flag at once, which the bundler cannot drop - so
 * the markup strings are imported individually and drawn inline, the same way `BrandArtwork` draws
 * the product mark. A page that needs further flags imports them itself and reuses these, so they
 * stay out of the shell chunk.
 */
export const LANGUAGE_FLAGS: Readonly<Record<(typeof LANGUAGES)[number]['country'], string>> = {
  CN: cnFlagMarkup,
  HK: hkFlagMarkup,
  MY: myFlagMarkup,
  US: usFlagMarkup,
};

/**
 * CountryFlag draws one flag's markup.
 *
 * Decorative by contract: a language's or currency's own name is always adjacent, so the flag is
 * never the only thing naming the choice - which is also why it carries no `title` of its own.
 */
export const CountryFlag: React.FC<{ markup: string; className?: string }> = ({ markup, className }) => (
  <span
    className={className ? `country-flag ${className}` : 'country-flag'}
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: markup }}
  />
);
