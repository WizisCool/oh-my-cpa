import { Select } from 'antd';
import { useT } from '../../i18n';

export function VertexModelOpenAPI({ value, onChange, disabled, label }: {
  value: boolean | null | undefined;
  onChange: (value: boolean | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const t = useT();
  return <Select aria-label={label ?? t('vertex.openapi_model')} disabled={disabled}
    value={value == null ? 'inherit' : value ? 'enabled' : 'disabled'}
    options={[
      { value: 'inherit', label: t('policy.override_inherit') },
      { value: 'enabled', label: t('policy.override_enabled') },
      { value: 'disabled', label: t('policy.override_disabled') },
    ]}
    onChange={(state) => onChange(state === 'inherit' ? null : state === 'enabled')} />;
}
