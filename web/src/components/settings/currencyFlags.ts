import auFlagMarkup from 'country-flag-icons/string/3x2/AU';
import caFlagMarkup from 'country-flag-icons/string/3x2/CA';
import euFlagMarkup from 'country-flag-icons/string/3x2/EU';
import gbFlagMarkup from 'country-flag-icons/string/3x2/GB';
import jpFlagMarkup from 'country-flag-icons/string/3x2/JP';
import krFlagMarkup from 'country-flag-icons/string/3x2/KR';
import sgFlagMarkup from 'country-flag-icons/string/3x2/SG';
import type { DisplayCurrencyCode } from '../../types/currencyDisplay';
import { LANGUAGE_FLAGS } from '../common/CountryFlag';

/** Flags the language switcher already ships are shared; only the rest load with this page. */
export const CURRENCY_FLAGS: Readonly<Record<DisplayCurrencyCode, string>> = {
  USD: LANGUAGE_FLAGS.US, CNY: LANGUAGE_FLAGS.CN, HKD: LANGUAGE_FLAGS.HK, MYR: LANGUAGE_FLAGS.MY,
  EUR: euFlagMarkup, JPY: jpFlagMarkup, GBP: gbFlagMarkup, SGD: sgFlagMarkup, KRW: krFlagMarkup, AUD: auFlagMarkup, CAD: caFlagMarkup,
};
