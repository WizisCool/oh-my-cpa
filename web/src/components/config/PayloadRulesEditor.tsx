import { useEffect, useState } from 'react';

import { Button, Collapse, Input, Modal, Select, Tag } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { Document } from 'yaml';

import {
  generateDynamicId,
  type PayloadKVCondition,
  type PayloadModelItem,
  type PayloadValidationIssue,
} from './payloadRules';
import {
  renderFilterCategoryContent,
  renderRawCategoryContent,
  renderTypedCategoryContent,
} from './payloadRuleSections';
import { usePayloadRulesDraft } from './usePayloadRulesDraft';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';

/** Re-exported for the page, which reports the issues back to the operator. */
export type { PayloadValidationIssue };

export interface PayloadRulesEditorProps {
  doc: Document | null;
  onDocChange: () => void;
  onValidationChange?: (issues: PayloadValidationIssue[]) => void;
  validateTrigger?: number;
}

export const PayloadRulesEditor: React.FC<PayloadRulesEditorProps> = ({
  doc,
  onDocChange,
  onValidationChange,
  validateTrigger,
}) => {
  // The draft is where every panel's state and every mutation lives; the panels
  // themselves are rendered by `payloadRuleSections`, each given this draft.
  const draft = usePayloadRulesDraft({ doc, onDocChange, onValidationChange, validateTrigger });
  const {
    activePanels,
    setActivePanels,
    defaultRules,
    defaultRawRules,
    overrideRules,
    overrideRawRules,
    filterRules,
    advModalState,
    setAdvModalState,
    updateModelInRule,
    t,
  } = draft;

  useOverlayHistory({
    isOpen: Boolean(advModalState?.open),
    onClose: () => setAdvModalState(null),
  });

  const items = [
    {
      key: 'default',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_default')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_default_desc')}</span>
          </div>
          {defaultRules.length > 0 && (
            <Tag className="payload-count-badge">{defaultRules.length}</Tag>
          )}
        </div>
      ),
      children: renderTypedCategoryContent(draft, 'default'),
    },
    {
      key: 'default-raw',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_default_raw')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_default_raw_desc')}</span>
          </div>
          {defaultRawRules.length > 0 && (
            <Tag className="payload-count-badge">{defaultRawRules.length}</Tag>
          )}
        </div>
      ),
      children: renderRawCategoryContent(draft, 'default-raw'),
    },
    {
      key: 'override',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_override')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_override_desc')}</span>
          </div>
          {overrideRules.length > 0 && (
            <Tag className="payload-count-badge">{overrideRules.length}</Tag>
          )}
        </div>
      ),
      children: renderTypedCategoryContent(draft, 'override'),
    },
    {
      key: 'override-raw',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_override_raw')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_override_raw_desc')}</span>
          </div>
          {overrideRawRules.length > 0 && (
            <Tag className="payload-count-badge">{overrideRawRules.length}</Tag>
          )}
        </div>
      ),
      children: renderRawCategoryContent(draft, 'override-raw'),
    },
    {
      key: 'filter',
      label: (
        <div className="payload-panel-header">
          <div className="payload-panel-title-wrap">
            <span className="payload-panel-title">{t('cfg.payload_cat_filter')}</span>
            <span className="payload-panel-desc">{t('cfg.payload_cat_filter_desc')}</span>
          </div>
          {filterRules.length > 0 && (
            <Tag className="payload-count-badge">{filterRules.length}</Tag>
          )}
        </div>
      ),
      children: renderFilterCategoryContent(draft),
    },
  ];

  // ── Advanced Model Modal ───────────────────────────────────────────────────
  const [advDraft, setAdvDraft] = useState<PayloadModelItem | null>(null);

  useEffect(() => {
    if (advModalState?.model) {
      setAdvDraft(JSON.parse(JSON.stringify(advModalState.model)));
    } else {
      setAdvDraft(null);
    }
  }, [advModalState]);

  const handleSaveAdvanced = () => {
    if (!advModalState || !advDraft) return;
    updateModelInRule(
      advModalState.category,
      advModalState.ruleIndex,
      advModalState.modelIndex,
      advDraft
    );
    setAdvModalState(null);
  };

  const renderKvEditor = (
    label: string,
    items: PayloadKVCondition[] = [],
    onChange: (items: PayloadKVCondition[]) => void
  ) => {
    return (
      <div className="payload-adv-field">
        <div className="payload-adv-kv-header">
          <label className="payload-adv-label">{label}</label>
          <Button
            size="small"
            type="link"
            icon={<PlusOutlined />}
            onClick={() =>
              onChange([
                ...items,
                { id: generateDynamicId('kv'), key: '', value: '' },
              ])
            }
          >
            {t('cfg.payload_adv_add_condition')}
          </Button>
        </div>
        <div className="payload-adv-kv-list">
          {items.map((it, idx) => (
            <div key={it.id} className="payload-adv-kv-row">
              <Input
                size="small"
                placeholder={t('cfg.payload_adv_kv_key')}
                value={it.key}
                onChange={(e) => {
                  const copy = [...items];
                  copy[idx] = { ...copy[idx], key: e.target.value };
                  onChange(copy);
                }}
              />
              <Input
                size="small"
                placeholder={t('cfg.payload_adv_kv_val')}
                value={it.value !== undefined && it.value !== null ? String(it.value) : ''}
                onChange={(e) => {
                  const copy = [...items];
                  copy[idx] = { ...copy[idx], value: e.target.value };
                  onChange(copy);
                }}
              />
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => onChange(items.filter((_, i) => i !== idx))}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="payload-rules-container">
      <Collapse
        activeKey={activePanels}
        onChange={(keys) => setActivePanels(Array.isArray(keys) ? keys : [keys])}
        items={items}
        className="payload-collapse"
      />

      {/* Advanced Model Conditions Modal */}
      <Modal
        title={`${t('cfg.payload_adv_title')} - ${advDraft?.name || t('cfg.payload_models_title')}`}
        open={Boolean(advModalState?.open)}
        onOk={handleSaveAdvanced}
        onCancel={() => setAdvModalState(null)}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        destroyOnClose
        width={600}
      >
        {advDraft && (
          <div className="payload-adv-modal-body">
            {/* from-protocol */}
            <div className="payload-adv-field">
              <label className="payload-adv-label">{t('cfg.payload_adv_from_proto')}</label>
              <Select
                size="small"
                style={{ width: '100%' }}
                allowClear
                placeholder="openai / responses / gemini / claude"
                value={advDraft.fromProtocol}
                options={[
                  { value: 'openai', label: 'openai' },
                  { value: 'responses', label: 'responses' },
                  { value: 'gemini', label: 'gemini' },
                  { value: 'claude', label: 'claude' },
                ]}
                onChange={(val) => setAdvDraft({ ...advDraft, fromProtocol: val })}
              />
            </div>

            {/* headers */}
            {renderKvEditor(
              t('cfg.payload_adv_headers'),
              advDraft.headers,
              (hdrs) => setAdvDraft({ ...advDraft, headers: hdrs })
            )}

            {/* match */}
            {renderKvEditor(
              t('cfg.payload_adv_match'),
              advDraft.match,
              (m) => setAdvDraft({ ...advDraft, match: m })
            )}

            {/* not-match */}
            {renderKvEditor(
              t('cfg.payload_adv_not_match'),
              advDraft.notMatch,
              (nm) => setAdvDraft({ ...advDraft, notMatch: nm })
            )}

            {/* exist paths */}
            <div className="payload-adv-field">
              <label className="payload-adv-label">{t('cfg.payload_adv_exist')}</label>
              <Select
                mode="tags"
                size="small"
                style={{ width: '100%' }}
                placeholder={t('cfg.payload_adv_add_path')}
                value={advDraft.exist ?? []}
                onChange={(tags) => setAdvDraft({ ...advDraft, exist: tags })}
              />
            </div>

            {/* not-exist paths */}
            <div className="payload-adv-field">
              <label className="payload-adv-label">{t('cfg.payload_adv_not_exist')}</label>
              <Select
                mode="tags"
                size="small"
                style={{ width: '100%' }}
                placeholder={t('cfg.payload_adv_add_path')}
                value={advDraft.notExist ?? []}
                onChange={(tags) => setAdvDraft({ ...advDraft, notExist: tags })}
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default PayloadRulesEditor;
