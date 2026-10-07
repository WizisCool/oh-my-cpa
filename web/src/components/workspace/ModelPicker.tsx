import React from 'react';
import { Select } from 'antd';
import { useI18n } from '../../i18n';
import { gatewayCallPointOf } from '../../types/gatewayModels';
import type { GatewayModelItem } from '../../types/gatewayModels';
import { resolveModelManufacturer } from '../../types/modelSquare';
import { BoxOutlined } from '../icons';
import { LobeIcon } from '../LobeIcon';
import styles from './Workspace.module.css';

export interface ModelPickerProps {
  models: GatewayModelItem[];
  value: string;
  isLoading: boolean;
  isDisabled: boolean;
  onChange: (model: string) => void;
}

/** The maker's mark for a call point, read from its name; an unrecognised name gets a neutral box. */
function ModelMark({ callPoint }: { callPoint: string }) {
  const manufacturer = resolveModelManufacturer(callPoint);
  const iconId = manufacturer.modelIconId || manufacturer.iconId;
  return iconId
    ? <LobeIcon iconId={iconId} size={14} />
    : <BoxOutlined className={styles['model-mark-fallback']} aria-hidden="true" />;
}

function ModelLabel({ callPoint }: { callPoint: string }) {
  return (
    <span className={styles['model-option']}>
      <ModelMark callPoint={callPoint} />
      <span className={styles['model-option-name']}>{callPoint}</span>
    </span>
  );
}

/**
 * The model half of the target: the key's call points, each led by its maker's mark.
 *
 * The mark is the whole of what the list adds to a name. A long list of similar call points is
 * scanned by family before it is read, and a mark does that without a second column to parse.
 */
export function ModelPicker({ models, value, isLoading, isDisabled, onChange }: ModelPickerProps) {
  const { t } = useI18n();
  const options = React.useMemo(
    () => models.map(item => ({ value: gatewayCallPointOf(item), label: gatewayCallPointOf(item) })),
    [models],
  );
  return (
    <Select
      className={styles['model-select']}
      aria-label={t('conversation.model')}
      placeholder={t('conversation.model')}
      value={value || undefined}
      loading={isLoading}
      disabled={isDisabled}
      options={options}
      showSearch={{ optionFilterProp: 'label' }}
      popupMatchSelectWidth={false}
      onChange={onChange}
      labelRender={() => <ModelLabel callPoint={value} />}
      optionRender={option => <ModelLabel callPoint={String(option.value)} />}
    />
  );
}
