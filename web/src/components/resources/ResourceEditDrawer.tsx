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
        color: resource.color || '#1677FF',
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
      color: '#1677FF',
      notes: '',
    });
  };

  const previewName = watchedName || resource.display_name || '未命名线路';
  const previewIcon = watchedIcon || resource.icon || 'custom';
  const previewColor = watchedColor || resource.color || '#1677FF';

  return (
    <Drawer
      title="整理与自定义 AI 接入点"
      placement="right"
      width={520}
      open={visible}
      onClose={onClose}
      bodyStyle={{ padding: '24px' }}
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={loading}
            onClick={() => form.submit()}
            style={{ backgroundColor: previewColor }}
          >
            保存并认领
          </Button>
        </Space>
      }
    >
      {/* Live Preview Card */}
      <div style={{ marginBottom: '24px' }}>
        <Text strong style={{ fontSize: '13px', color: '#64748b', display: 'block', marginBottom: '8px' }}>
          实时卡片预览 (Live Preview)
        </Text>
        <Card
          size="small"
          style={{
            borderRadius: '10px',
            border: `1.5px solid ${previewColor}50`,
            background: `linear-gradient(135deg, #ffffff 0%, ${previewColor}08 100%)`,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.05)',
          }}
          bodyStyle={{ padding: '16px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '8px',
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
                <Text strong style={{ fontSize: '15px', color: '#0f172a' }}>
                  {previewName}
                </Text>
                <Tag color="success" style={{ margin: 0, fontSize: '11px', borderRadius: '4px' }}>
                  已整理
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
              <span style={{ fontWeight: 600 }}>显示名称 (Display Name)</span>
              <Tooltip title="为这个端点设置清晰的中文或业务名称，如「DeepSeek 官方主线路」、「GOAT 个人订阅」、「OpenAI 团队号」">
                <InfoCircleOutlined style={{ color: '#94a3b8' }} />
              </Tooltip>
            </Space>
          }
          rules={[{ required: true, message: '请输入显示名称' }]}
        >
          <Input
            placeholder="例如：DeepSeek 官方主线路 / GOAT 团队套餐"
            size="large"
            maxLength={64}
            allowClear
          />
        </Form.Item>

        {/* Icon Preset Selector */}
        <Form.Item
          name="icon"
          label={<span style={{ fontWeight: 600 }}>品牌图标预设 (Icon Preset)</span>}
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
                        borderRadius: '8px',
                        border: isSelected
                          ? `2px solid ${previewColor}`
                          : '1px solid #e2e8f0',
                        backgroundColor: isSelected ? `${previewColor}10` : '#f8fafc',
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
                        style={{ color: isSelected ? previewColor : '#475569' }}
                      />
                      <span
                        style={{
                          fontSize: '11px',
                          color: isSelected ? previewColor : '#334155',
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
          label={<span style={{ fontWeight: 600 }}>标识色彩 (Theme Color)</span>}
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
                      boxShadow: isSelected
                        ? `0 0 0 3px #ffffff, 0 0 0 5px ${color.hex}`
                        : '0 1px 3px rgba(0,0,0,0.1)',
                      transition: 'all 0.2s ease',
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
          label={<span style={{ fontWeight: 600 }}>备注 / 用途说明 (Optional Notes)</span>}
        >
          <Input.TextArea
            placeholder="例如：团队主力编码线路，月付套餐，续费日每月 15 号"
            rows={3}
            maxLength={200}
            showCount
          />
        </Form.Item>

        {/* Status Option */}
        <Form.Item
          name="status"
          label={<span style={{ fontWeight: 600 }}>资源状态 (Status)</span>}
        >
          <Radio.Group buttonStyle="solid">
            <Radio.Button value="claimed">已认领 (Claimed)</Radio.Button>
            <Radio.Button value="unclaimed">待整理 (Unclaimed)</Radio.Button>
            <Radio.Button value="ignored">忽略 (Ignored)</Radio.Button>
          </Radio.Group>
        </Form.Item>
      </Form>

      {/* Technical Collapsible Details */}
      <Collapse
        ghost
        style={{ marginTop: '20px', borderTop: '1px solid #f1f5f9' }}
        items={[
          {
            key: 'tech-details',
            label: (
              <Text type="secondary" style={{ fontSize: '12px' }}>
                <InfoCircleOutlined style={{ marginRight: '6px' }} />
                底层 CPA 技术配置详情 (Read-Only)
              </Text>
            ),
            children: (
              <div
                style={{
                  backgroundColor: '#f8fafc',
                  padding: '12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  color: '#334155',
                }}
              >
                <div><strong>CPA 资源类型:</strong> {resource.cpa_resource_type}</div>
                <div><strong>CPA 驱动:</strong> {resource.cpa_driver}</div>
                <div><strong>协议规范:</strong> {resource.protocol_driver}</div>
                {resource.base_url && <div><strong>接入点 Base URL:</strong> {resource.base_url}</div>}
                {resource.cpa_auth_index && <div><strong>Auth Index:</strong> {resource.cpa_auth_index}</div>}
                {resource.cpa_resource_name && <div><strong>资源标识:</strong> {resource.cpa_resource_name}</div>}
                {resource.details?.models && (
                  <div style={{ marginTop: '6px' }}>
                    <strong>支持模型 ({resource.details.models.length}):</strong>
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
          style={{ color: '#94a3b8' }}
        >
          重置表单为推测默认值
        </Button>
      </div>
    </Drawer>
  );
};
