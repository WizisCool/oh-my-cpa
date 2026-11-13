import auFlagMarkup from 'country-flag-icons/string/3x2/AU';
import caFlagMarkup from 'country-flag-icons/string/3x2/CA';
import cnFlagMarkup from 'country-flag-icons/string/3x2/CN';
import euFlagMarkup from 'country-flag-icons/string/3x2/EU';
import gbFlagMarkup from 'country-flag-icons/string/3x2/GB';
import hkFlagMarkup from 'country-flag-icons/string/3x2/HK';
import jpFlagMarkup from 'country-flag-icons/string/3x2/JP';
import krFlagMarkup from 'country-flag-icons/string/3x2/KR';
import myFlagMarkup from 'country-flag-icons/string/3x2/MY';
import sgFlagMarkup from 'country-flag-icons/string/3x2/SG';
import usFlagMarkup from 'country-flag-icons/string/3x2/US';
import type { DisplayCurrencyCode } from '../../types/currencyDisplay';

/** Each currency's issuer, drawn beside its code; the flags load with this page only. */
export const CURRENCY_FLAGS: Readonly<Record<DisplayCurrencyCode, string>> = {
  USD: usFlagMarkup, CNY: cnFlagMarkup, HKD: hkFlagMarkup, MYR: myFlagMarkup,
  EUR: euFlagMarkup, JPY: jpFlagMarkup, GBP: gbFlagMarkup, SGD: sgFlagMarkup, KRW: krFlagMarkup, AUD: auFlagMarkup, CAD: caFlagMarkup,
};
