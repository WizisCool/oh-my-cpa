import React from 'react';

/**
 * CountryFlag draws one flag's markup.
 *
 * Decorative by contract: the currency's own code and name are always adjacent, so the flag is
 * never the only thing naming the choice - which is also why it carries no `title` of its own.
 */
export const CountryFlag: React.FC<{ markup: string; className?: string }> = ({ markup, className }) => (
  <span
    className={className ? `country-flag ${className}` : 'country-flag'}
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: markup }}
  />
);
