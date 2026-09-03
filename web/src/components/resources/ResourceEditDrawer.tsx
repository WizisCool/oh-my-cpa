import React, { useEffect } from 'react';
import {
  Drawer,
  Form,
  Input,
  Radio,
  Button,
  Space,
  Typography,
  Collapse,
  Card,
  Tag,
  Tooltip,
  Row,
  Col,
} from 'antd';
import {
  CheckOutlined,
  InfoCircleOutlined,
  SaveOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useT } from '../../i18n';
import {
  DiscoveredResource,
  ResourceOverridePayload,
  ICON_PRESETS,
  COLOR_PRESETS,
} from '../../types/resource';
import { PresetIcon } from '../icons/PresetIcon';

const { Text } = Typography;

interface ResourceEditDrawerProps {
  visible: boolean;
  resource: DiscoveredResource | null;
  onClose: () => void;
  onSave: (resourceId: string, payload: ResourceOverridePayload) => Promise<void>;
  loading?: boolean;
}

export const ResourceEditDrawer: React.FC<ResourceEditDrawerProps> = ({
  visible,
  resource,
  onClose,
  onSave,
  loading = false,
}) => {
  const t = useT();
  const [form] = Form.useForm<ResourceOverridePayload>();

  // Watch form fields for live preview
  const watchedName = Form.useWatch('display_name', form);
  const watchedIcon = Form.useWatch('icon', form);
  const watchedColor = Form.useWatch('color', form);

  useEffect(() => {
    if (resource && visible) {
      form.setFieldsValue({
        display_name: resource.custom_display_name || resource.display_name || '',
        icon: resource.icon || 'custom',
        color: resource.color || '#007aff',
        notes: resource.notes || '',
        status: resource.status || 'claimed',
      });
    }
  }, [resource, visible, form]);

  if (!resource) return null;

  const handleFinish = async (values: ResourceOverridePayload) => {
    // If saving from triage, set status to claimed by default unless specified
    const payload: ResourceOverridePayload = {
      ...values,
      status: values.status || 'claimed',
    };
    await onSave(resource.id, payload);
    onClose();
  };

  const handleResetToDefault = () => {
    form.setFieldsValue({
      display_name: resource.suggested_source || resource.cpa_resource_name || '',
      icon: 'custom',
      color: '#007aff',
      notes: '',
    });
  };

  const previewName = watchedName || resource.display_name || t('res.unnamed');
  const previewIcon = watchedIcon || resource.icon || 'custom';
  const previewColor = watchedColor || resource.color || '#007aff';

  return (
    <Drawer
      title={t('res.drawer_title')}
      placement="right"
      width={520}
      open={visible}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={loading}
            onClick={() => form.submit()}
            style={{ backgroundColor: previewColor }}
          >
            {t('res.save_claim')}
          </Button>
        </Space>
      }
    >
      {/* Live Preview Card */}
      <div style={{ marginBottom: '24px' }}>
        <Text strong style={{ fontSize: '13px', color: 'var(--muted)', display: 'block', marginBottom: '8px' }}>
          {t('res.preview')}
        </Text>
        <Card
          size="small"
          style={{
            borderRadius: '4px',
            border: `1.5px solid ${previewColor}`,
            background: 'var(--bg)',
          }}
          styles={{ body: { padding: '16px' } }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '4px',
                backgroundColor: `${previewColor}20`,
                color: previewColor,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: `1px solid ${previewColor}40`,
                flexShrink: 0,
              }}
            >
              <PresetIcon name={previewIcon} size={22} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Text strong style={{ fontSize: '15px' }}>
                  {previewName}
                </Text>
                <Tag color="success" style={{ margin: 0, fontSize: '11px', borderRadius: '4px' }}>
                  {t('res.preview_tag')}
                </Tag>
              </div>
              <Text type="secondary" style={{ fontSize: '12px', display: 'block', marginTop: '2px' }}>
                {resource.protocol_display || resource.protocol_driver} · CPA: {resource.cpa_driver}
              </Text>
            </div>
          </div>
        </Card>
      </div>

      {/* Main Form */}
      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        requiredMark={false}
      >
        {/* Display Name */}
        <Form.Item
          name="display_name"
          label={
            <Space>
              <span style={{ fontWeight: 600 }}>{t('res.name_label')}</span>
              <Tooltip title={t('res.name_tooltip')}>
                <InfoCircleOutlined style={{ color: 'var(--muted)' }} />
              </Tooltip>
            </Space>
          }
          rules={[{ required: true, message: t('res.name_required') }]}
        >
          <Input
            placeholder={t('res.name_ph')}
            size="large"
            maxLength={64}
            allowClear
          />
        </Form.Item>

        {/* Icon Preset Selector */}
        <Form.Item
          name="icon"
          label={<span style={{ fontWeight: 600 }}>{t('res.icon_label')}</span>}
        >
          <Radio.Group style={{ width: '100%' }}>
            <Row gutter={[8, 8]}>
              {ICON_PRESETS.map((preset) => {
                const isSelected = (watchedIcon || resource.icon) === preset.key;
                return (
                  <Col span={8} key={preset.key}>
                    <div
                      onClick={() => {
                        form.setFieldsValue({ icon: preset.key });
                        // Also suggest default color if not already custom
                        if (!watchedColor || watchedColor === resource.color) {
                          form.setFieldsValue({ color: preset.defaultColor });
                        }
                      }}
                      style={{
                        padding: '10px 8px',
                        borderRadius: '4px',
                        border: isSelected
                          ? `2px solid ${previewColor}`
                          : '1px solid var(--border)',
                        backgroundColor: isSelected ? `${previewColor}10` : 'var(--bg)',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '6px',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <PresetIcon
                        name={preset.key}
                        size={20}
                        style={{ color: isSelected ? previewColor : 'var(--muted)' }}
                      />
                      <span
                        style={{
                          fontSize: '11px',
                          color: isSelected ? previewColor : 'var(--fg-2)',
                          fontWeight: isSelected ? 600 : 400,
                          textAlign: 'center',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          width: '100%',
                        }}
                      >
                        {preset.name}
                      </span>
                    </div>
                  </Col>
                );
              })}
            </Row>
          </Radio.Group>
        </Form.Item>

        {/* Color Palette Chips */}
        <Form.Item
          name="color"
          label={<span style={{ fontWeight: 600 }}>{t('res.color_label')}</span>}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {COLOR_PRESETS.map((color) => {
              const isSelected = (watchedColor || resource.color) === color.hex;
              return (
                <Tooltip title={color.label} key={color.hex}>
                  <div
                    onClick={() => form.setFieldsValue({ color: color.hex })}
                    style={{
                      width: '32px',
                      height: '32px',
                      borderRadius: '50%',
                      backgroundColor: color.hex,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      outline: isSelected ? `2px solid var(--fg)` : 'none',
                      outlineOffset: '2px',
                    }}
                  >
                    {isSelected && <CheckOutlined style={{ color: '#ffffff', fontSize: '14px' }} />}
                  </div>
                </Tooltip>
              );
            })}
          </div>
        </Form.Item>

        {/* Notes */}
        <Form.Item
          name="notes"
          label={<span style={{ fontWeight: 600 }}>{t('res.notes_label')}</span>}
        >
          <Input.TextArea
            placeholder={t('res.notes_ph')}
            rows={3}
            maxLength={200}
            showCount
          />
        </Form.Item>

        {/* Status Option */}
        <Form.Item
          name="status"
          label={<span style={{ fontWeight: 600 }}>{t('res.status_label')}</span>}
        >
          <Radio.Group buttonStyle="solid">
            <Radio.Button value="claimed">{t('res.status_claimed')}</Radio.Button>
            <Radio.Button value="unclaimed">{t('res.status_unclaimed')}</Radio.Button>
            <Radio.Button value="ignored">{t('res.status_ignored')}</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </Form>

      {/* Technical Collapsible Details */}
      <Collapse
        ghost
        style={{ marginTop: '20px', borderTop: '1px solid var(--border-soft)' }}
        items={[
          {
            key: 'tech-details',
            label: (
              <Text type="secondary" style={{ fontSize: '12px' }}>
                <InfoCircleOutlined style={{ marginRight: '6px' }} />
                {t('res.tech_details')}
              </Text>
            ),
            children: (
              <div
                style={{
                  backgroundColor: 'var(--bg)',
                  padding: '12px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                }}
              >
                <div><strong>{t('res.tech_type')}</strong> {resource.cpa_resource_type}</div>
                <div><strong>{t('res.tech_driver')}</strong> {resource.cpa_driver}</div>
                <div><strong>{t('res.tech_protocol')}</strong> {resource.protocol_driver}</div>
                {resource.base_url && <div><strong>{t('res.tech_baseurl')}</strong> {resource.base_url}</div>}
                {resource.cpa_auth_index && <div><strong>Auth Index:</strong> {resource.cpa_auth_index}</div>}
                {resource.cpa_resource_name && <div><strong>{t('res.tech_resource')}</strong> {resource.cpa_resource_name}</div>}
                {resource.details?.models && (
                  <div style={{ marginTop: '6px' }}>
                    <strong>{t('res.tech_models', { n: resource.details.models.length })}</strong>
                    <div style={{ maxHeight: '80px', overflowY: 'auto', marginTop: '4px' }}>
                      {resource.details.models.join(', ')}
                    </div>
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />

      <div style={{ marginTop: '16px', textAlign: 'right' }}>
        <Button
          type="link"
          size="small"
          icon={<ReloadOutlined />}
          onClick={handleResetToDefault}
          style={{ color: 'var(--muted)' }}
        >
          {t('res.reset')}
        </Button>
      </div>
    </Drawer>
  );
};
