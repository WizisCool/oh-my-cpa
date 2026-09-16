import React from 'react';
import { Alert, Button, Input, Tag, Typography } from 'antd';
import { CheckOutlined, FormatPainterOutlined } from '@ant-design/icons';
import { useT } from '../../i18n';
import { parsePluginConfig, pluginConfigSummary } from './pluginConfig';
import styles from './PluginConfigEditor.module.css';

const { Text } = Typography;

export interface PluginConfigEditorProps {
  value: string;
  onChange: (value: string) => void;
  pluginName: string;
}

export const PluginConfigEditor: React.FC<PluginConfigEditorProps> = ({ value, onChange, pluginName }) => {
  const t = useT();
  const parsed = React.useMemo(() => parsePluginConfig(value), [value]);
  const summary = React.useMemo(
    () => (parsed.value ? pluginConfigSummary(parsed.value) : []),
    [parsed.value],
  );

  const formatValue = () => {
    if (!parsed.value) return;
    onChange(JSON.stringify(parsed.value, null, 2));
  };

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <div className={styles.validity}>
          {parsed.error === 'duplicate-key' ? (
            <Tag color="error">{t('plg.config_duplicate_key', { key: parsed.key ?? '' })}</Tag>
          ) : parsed.error ? (
            <Tag color="error">{t('plg.config_invalid_json')}</Tag>
          ) : (
            <Tag color="success" icon={<CheckOutlined />}>{t('plg.config_valid')}</Tag>
          )}
          <Text type="secondary">{t('plg.config_top_level', { n: summary.length })}</Text>
        </div>
        <Button size="small" icon={<FormatPainterOutlined />} disabled={!parsed.value} onClick={formatValue}>
          {t('plg.config_format')}
        </Button>
      </div>

      {parsed.error && (
        <Alert
          type="error"
          showIcon
          description={parsed.error === 'duplicate-key' ? t('plg.config_duplicate_key_desc') : t('plg.config_json_desc')}
        />
      )}

      <div className={styles.workspace}>
        <Input.TextArea
          data-plugin-config-source
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={12}
          spellCheck={false}
          aria-label={t('plg.config_title', { name: pluginName })}
          className={styles.source}
        />
        <div className={styles.summary} data-plugin-config-summary aria-label={t('plg.config_preview')}>
          <div className={styles['summary-title']}>{t('plg.config_preview')}</div>
          {summary.length === 0 ? (
            <Text type="secondary">{t('plg.config_empty')}</Text>
          ) : (
            <ul className={styles['summary-list']}>
              {summary.map((entry) => (
                <li key={entry.key}>
                  <span className={styles['summary-key']}>{entry.key}</span>
                  <span className={styles['summary-type']}>{entry.type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
