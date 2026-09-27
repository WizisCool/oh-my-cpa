import React from 'react';
import { ConfigProvider } from 'antd';
import type { XProviderProps } from '@ant-design/x';
import { useI18n } from '../../i18n';

/**
 * The console's locale, extended with the strings Ant Design X renders itself.
 *
 * X ships its own catalogue for a handful of built-in labels (the stop and edit controls), and
 * reading the console's dictionary here keeps those in the language every other control on the
 * page is in, for all four registered languages rather than only the two X translates.
 */
export function useXLocale(): XProviderProps['locale'] {
  const { t, lang } = useI18n();
  const { locale } = React.useContext(ConfigProvider.ConfigContext);
  return React.useMemo(() => ({
    ...locale,
    locale: locale?.locale ?? lang,
    Sender: { stopLoading: t('pg.stop'), speechRecording: t('pg.input') },
    Bubble: { editableOk: t('common.confirm'), editableCancel: t('common.cancel') },
  }) as XProviderProps['locale'], [lang, locale, t]);
}
