import { useI18n } from '../../i18n';
import { DEFAULT_INFERENCE_ENDPOINT, INFERENCE_ENDPOINT_PATHS, INFERENCE_ENDPOINTS, parseInferenceEndpoint } from '../../types/inferenceEndpoints';
import type { InferenceEndpoint } from '../../types/inferenceEndpoints';
import { ApiOutlined } from '../icons';
import { ComposerPicker, ComposerPickerList } from './ComposerPicker';
import styles from './Workspace.module.css';

export interface EndpointPickerProps {
  value: InferenceEndpoint;
  onChange: (value: InferenceEndpoint) => void;
  isDisabled?: boolean;
}

/**
 * Which inference endpoint the next message is sent to: a setting of the message, so it is a chip
 * in the composer on the surface the model and effort chips share. The chip carries the short
 * name; the list names each endpoint in full with the path that tells similar names apart.
 */
export function EndpointPicker({ value, onChange, isDisabled = false }: EndpointPickerProps) {
  const { t } = useI18n();
  return (
    <ComposerPicker
      label={t('conversation.endpoint')}
      valueLabel={t(`conversation.endpoint.${value}`)}
      icon={<ApiOutlined />}
      testId="endpoint-chip"
      contentTestId="endpoint-popover"
      isDisabled={isDisabled}
      surfaceClassName={styles['endpoint-surface']}
    >
      {close => (
        <>
          <div className={styles['picker-head']}><span>{t('conversation.endpoint')}</span></div>
          <ComposerPickerList
            label={t('conversation.endpoint')}
            value={value}
            options={INFERENCE_ENDPOINTS.map(endpoint => ({
              value: endpoint,
              label: t(`conversation.endpoint.${endpoint}.name`),
              detail: INFERENCE_ENDPOINT_PATHS[endpoint],
            }))}
            onSelect={next => { onChange(parseInferenceEndpoint(next) ?? DEFAULT_INFERENCE_ENDPOINT); close(); }}
          />
        </>
      )}
    </ComposerPicker>
  );
}
