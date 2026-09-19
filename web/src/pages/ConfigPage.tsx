import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  AppstoreOutlined,
  CodeOutlined,
  CopyOutlined,
  FormatPainterOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import { copyText } from '../utils/clipboard';
import { useTheme } from '../theme/ThemeContext';
import { ConfigDirtyBar } from '../components/config/ConfigDirtyBar';
import { useConfigDraft } from '../components/config/useConfigDraft';
import { useOverlayHistory } from '../hooks/useOverlayHistory';
import {
  renderGroupPanel,
  sectionIcon,
  type ConfigSectionContext,
} from '../components/config/configSectionRenderers';

const YamlSourceEditor = React.lazy(() => import('../components/config/YamlSourceEditor'));
import { parseDocument } from 'yaml';
import {
  ALL_CONFIG_FIELDS,
  CONFIG_SECTIONS,
  CONFIG_GROUPS,
  getGroupsForSection,
  type ConfigGroupDefinition,
} from '../types/configSchema';

const { Text } = Typography;

export const ConfigPage: React.FC = () => {
  const t = useT();
  // The demonstration refuses the gateway configuration write, because it writes to
  // CPA's own file. The editor stays usable so the page can be read and explored; only
  // the save is withheld.
  const isDemo = isDemoMode();
  const { message } = AntdApp.useApp();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const draft = useConfigDraft();
  const {
    editorRef,
    viewMode,
    activeSection,
    setActiveSection,
    searchQuery,
    setSearchQuery,
    configQuery,
    rawYaml,
    setRawYaml,
    conflictState,
    setConflictState,
    saveError,
    setSaveError,
    docRef,
    isDirty,
    getFieldValue,
    saveMutation,
    showErrorFeedback,
    handleDiscardChanges,
    payloadIssues,
    hasYamlErrors,
    hasConfigErrors,
    saveConfig,
    requestSaveConfirmation,
    handleViewModeChange,
  } = draft;

  // The revision-conflict dialog is a decision the operator must make before the draft can be
  // saved, so Back dismissing it is the same as its own Cancel: the draft is untouched and the
  // conflict stays reported by the save flow.
  useOverlayHistory({ isOpen: Boolean(conflictState), onClose: () => setConflictState(null) });

  // ── API Keys ────────────────────────────────────────────
  // The key list is edited on its own page (/api-keys), which is the only editor
  // of that field (ADR 0010). What the configuration panel owns is the pointer to
  // it: a group that names the field, states how many keys are configured, and
  // leads there. Hiding the group instead - what this page did before - left the
  // panel silent about a field it owns. The `apiKeys` schema field itself stays:
  // the source view still renders the whole document, and semantic comparison of
  // that document still has to account for `api-keys`.
  const apiKeysField = React.useMemo(
    () => ALL_CONFIG_FIELDS.find((field) => field.id === 'apiKeys'),
    [],
  );

  const configuredKeyCount = React.useMemo(() => {
    if (!apiKeysField) return 0;
    if (!docRef.current) {
      try {
        docRef.current = parseDocument(rawYaml || '');
      } catch {
        return 0;
      }
    }
    const value = getFieldValue(apiKeysField);
    if (Array.isArray(value)) return value.length;
    return typeof value === 'string' && value ? 1 : 0;
  }, [apiKeysField, rawYaml, getFieldValue]);


  const currentSectionDef = React.useMemo(() => {
    return CONFIG_SECTIONS.find((s) => s.id === activeSection) ?? CONFIG_SECTIONS[0];
  }, [activeSection]);

  // Matching fields grouped by semantic group for search view
  const searchMatchedGroups = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const results: { group: ConfigGroupDefinition; matchedFieldIds: string[] }[] = [];
    for (const grp of CONFIG_GROUPS) {
      const matched = grp.fieldIds.filter((fid) => {
        const f = ALL_CONFIG_FIELDS.find((item) => item.id === fid);
        if (!f) return false;
        const label = t(f.labelKey).toLowerCase();
        const desc = t(f.descKey).toLowerCase();
        const yamlKey = f.yamlPath.join('.').toLowerCase();
        const keywords = (f.keywords ?? []).join(' ').toLowerCase();
        return label.includes(q) || desc.includes(q) || yamlKey.includes(q) || keywords.includes(q);
      });
      if (matched.length > 0) {
        results.push({ group: grp, matchedFieldIds: matched });
      }
    }
    return results;
  }, [searchQuery, t]);

  const totalSearchMatches = React.useMemo(() => {
    return searchMatchedGroups.reduce((acc, g) => acc + g.matchedFieldIds.length, 0);
  }, [searchMatchedGroups]);

  // Render individual input/select/switch control
  const sectionContext: ConfigSectionContext = {
    ...draft,
    doc: docRef.current,
    configuredKeyCount,
    navigate,
    searchQuery,
    searchMatchedGroups,
    t,
  };

  return (
    <div className="terminal-page config-page">
      {/* Full-width sticky toolbar: the action group is pushed to the viewport's
          right edge so it lines up with the global header. */}
      <div className="config-toolbar">
        <div className="config-toolbar-left">
          <h1 className="terminal-title">{t('nav.config')}</h1>
          {configQuery.isPending && !rawYaml ? (
            <Tag className="config-sync-badge">{t('cfg.items_count', { n: ALL_CONFIG_FIELDS.length, status: t('cfg.status_loading') })}</Tag>
          ) : configQuery.isError && !rawYaml ? (
            <Tag color="error" className="config-sync-badge">{t('cfg.status_error')}</Tag>
          ) : configQuery.isError && rawYaml ? (
            <Tag color="warning" className="config-sync-badge">{t('cfg.items_count', { n: ALL_CONFIG_FIELDS.length, status: t('cfg.status_stale') })}</Tag>
          ) : isDirty ? (
            <Tag color="warning" className="config-sync-badge">{t('cfg.items_count', { n: ALL_CONFIG_FIELDS.length, status: t('cfg.source_dirty') })}</Tag>
          ) : (
            <Tag color="success" className="config-sync-badge">{t('cfg.items_count', { n: ALL_CONFIG_FIELDS.length, status: t('cfg.source_clean') })}</Tag>
          )}
          <Segmented
            size="small"
            value={viewMode}
            onChange={(val) => void handleViewModeChange(val as 'visual' | 'source')}
            options={[
              { value: 'visual', label: t('cfg.mode_visual'), icon: <AppstoreOutlined /> },
              { value: 'source', label: t('cfg.mode_source'), icon: <CodeOutlined /> },
            ]}
          />
        </div>

        <div className="config-toolbar-actions">
          {viewMode === 'visual' && (
            <Input
              size="small"
              className="config-search-input"
              prefix={<SearchOutlined />}
              allowClear
              placeholder={t('cfg.search_placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          )}

          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => void configQuery.refetch()}
            loading={configQuery.isFetching}
            disabled={isDirty}
          >
            {t('cfg.reload')}
          </Button>

          {/* Discard needs no confirmation: it is the non-destructive direction. */}
          {isDirty && (
            <Button
              size="small"
              icon={<UndoOutlined />}
              disabled={saveMutation.isPending}
              onClick={handleDiscardChanges}
            >
              {t('cfg.dirty_bar_discard')}
            </Button>
          )}

          {/* Save. Blocking validation errors are reported by saveConfig itself,
              so that branch does not confirm first: there is nothing to confirm
              when the save cannot proceed. A valid document goes through the
              popconfirm and then straight to saveConfig - the bottom bar owns
              that confirmation, so it must not ask a second time through the
              global modal the keyboard path uses. */}
          {hasConfigErrors ? (
            <Button
              size="small"
              type="primary"
              icon={<SaveOutlined />}
              loading={saveMutation.isPending}
              disabled={!isDirty || isDemo}
              title={isDemo ? t('demo.blocked') : undefined}
              onClick={saveConfig}
            >
              {t('cfg.source_save')}
            </Button>
          ) : (
            <Popconfirm
              title={t('cfg.source_save_confirm')}
              description={t('cfg.source_save_confirm_desc')}
              onConfirm={saveConfig}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
              disabled={!isDirty || saveMutation.isPending || isDemo}
            >
              <Button
                size="small"
                type="primary"
                icon={<SaveOutlined />}
                loading={saveMutation.isPending}
                disabled={!isDirty || isDemo}
                title={isDemo ? t('demo.blocked') : undefined}
              >
                {t('cfg.source_save')}
              </Button>
            </Popconfirm>
          )}
        </div>
      </div>

      {saveError && (
        <Alert
          type="error"
          showIcon
          closable
          onClose={() => setSaveError(null)}
          description={saveError}
          style={{ marginBottom: 16 }}
        />
      )}

      {configQuery.isError && (
        <Alert
          type="error"
          showIcon
          description={t('cfg.load_failed') + ' — ' + t('cfg.load_failed_desc')}
          action={
            <Button size="small" type="primary" onClick={() => void configQuery.refetch()}>
              {t('common.retry')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {configQuery.isPending && !rawYaml ? (
        <Card size="small" className="config-card">
          <Skeleton active paragraph={{ rows: 10 }} />
        </Card>
      ) : configQuery.isError && !rawYaml ? (
        <Card size="small" className="config-card">
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Alert type="warning" showIcon description={t('cfg.load_failed_desc')} />
          </div>
        </Card>
      ) : viewMode === 'visual' ? (
        /* Visual mode: sticky section nav, settings canvas, and a balancing
           right gutter — a three-track grid, not two columns. */
        <div className="config-workbench">
          {/* Left: sticky section navigation in the 216px track */}
          <aside className="config-section-nav" aria-label={t('cfg.nav_aria')}>
            {CONFIG_SECTIONS.map((sec) => {
              const isActive = !searchQuery && activeSection === sec.id;
              return (
                <button
                  key={sec.id}
                  type="button"
                  className={`config-nav-btn${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => {
                    setSearchQuery('');
                    setActiveSection(sec.id);
                  }}
                >
                  <span className="config-nav-btn-left">
                    {sectionIcon(sectionContext, sec.id)}
                    <span>{t(sec.labelKey)}</span>
                  </span>
                </button>
              );
            })}
          </aside>

          {/* Right: Focused Settings Group Canvas (max-width: 920px) */}
          <main className="config-main">
            <div className="config-section-header">
              <h2 className="config-section-title">
                {searchQuery
                  ? t('cfg.search_results', { n: totalSearchMatches, q: searchQuery })
                  : t(currentSectionDef.labelKey)}
              </h2>
              <p className="config-section-desc">
                {searchQuery ? t('cfg.search_placeholder') : t(currentSectionDef.descKey)}
              </p>
            </div>

            {searchQuery ? (
              /* Search Results: Grouped by semantic Setting Group Panels */
              <div className="settings-stack">
                {searchMatchedGroups.map((sg) => renderGroupPanel(sectionContext, sg.group, sg.matchedFieldIds, 'search'))}
              </div>
            ) : (
              /* Standard Section Group Panels */
              <div className="settings-stack">
                {getGroupsForSection(activeSection).map((grp) => renderGroupPanel(sectionContext, grp))}
              </div>
            )}
          </main>
        </div>
      ) : (
        /* ── Source Mode: YAML Editor ───────────────────────────────────── */
        <div className="config-source-container">
          <div className="config-source-toolbar">
            <Space size={12}>
              <Tag color={isDirty ? 'warning' : 'success'}>
                {isDirty ? t('cfg.source_dirty') : t('cfg.source_clean')}
              </Tag>
              {rawYaml && (
                <Text type="secondary" className="mono-num">
                  {(new Blob([rawYaml]).size / 1024).toFixed(1)} KB · {t('cfg.lines_count', { n: rawYaml.split('\n').length })}
                </Text>
              )}
            </Space>
            <Space size={8}>
              <Button
                size="small"
                icon={<SearchOutlined />}
                disabled={!rawYaml}
                onClick={() => editorRef.current?.find()}
              >
                {t('cfg.source_find')}
              </Button>
              <Button
                size="small"
                icon={<FormatPainterOutlined />}
                disabled={!rawYaml}
                onClick={() => {
                  if (!editorRef.current) return;
                  editorRef.current
                    .formatDocument()
                    .then(() => {
                      message.success(t('cfg.source_format_success'));
                    })
                    .catch((err: unknown) => {
                      const errMsg = err instanceof Error ? err.message : '';
                      message.error(
                        errMsg
                          ? `${t('cfg.source_format_error')}: ${errMsg}`
                          : t('cfg.source_format_error')
                      );
                    });
                }}
              >
                {t('cfg.source_format')}
              </Button>
              <Button
                size="small"
                icon={<CopyOutlined />}
                disabled={!rawYaml}
                onClick={async () => {
                  if (await copyText(rawYaml)) {
                    message.success(t('cfg.source_copy_success'));
                    return;
                  }
                  message.error(t('cfg.copy_failed'));
                }}
              >
                {t('cfg.source_copy')}
              </Button>
            </Space>
          </div>

          <div className="config-editor-wrap">
            <React.Suspense
              fallback={
                <div className="config-monaco-loading">
                  <Skeleton active paragraph={{ rows: 14 }} />
                </div>
              }
            >
              <YamlSourceEditor
                value={rawYaml}
                onChange={(val) => {
                  setRawYaml(val);
                  try {
                    docRef.current = parseDocument(val);
                  } catch {
                    // user is still editing invalid YAML
                  }
                }}
                onSave={requestSaveConfirmation}
                theme={theme}
                editorRef={editorRef}
                loadingText={t('cfg.source_editor_loading')}
              />
            </React.Suspense>
          </div>

          <div className="config-source-hint">
            <Text type="secondary" style={{ fontSize: 11 }}>
              <kbd>Ctrl+S</kbd> / <kbd>Cmd+S</kbd> {t('cfg.save_shortcut', { key: '' })}
            </Text>
          </div>
        </div>
      )}

      {/* Floating Bottom Dirty Action Bar.
          It owns its own confirmation, so it is handed the save itself rather
          than the confirming entry point: chaining the two produced a popconfirm
          followed by a second global modal asking the same question. */}
      <ConfigDirtyBar
        isDirty={isDirty}
        isSaving={saveMutation.isPending}
        yamlError={hasYamlErrors}
        payloadIssuesCount={payloadIssues.length}
        showErrorFeedback={showErrorFeedback}
        onSave={saveConfig}
        onDiscard={handleDiscardChanges}
        disabled={isDemo}
      />

      {/* ── Conflict Modal ────────────────────────────────────────────── */}
      <Modal
        open={Boolean(conflictState)}
        title={t('cfg.conflict_title')}
        footer={[
          <Button
            key="copy"
            icon={<CopyOutlined />}
            onClick={async () => {
              if (await copyText(rawYaml)) {
                message.success(t('cfg.source_copy_success'));
                return;
              }
              message.error(t('cfg.copy_failed'));
            }}
          >
            {t('cfg.conflict_copy')}
          </Button>,
          <Button
            key="reload"
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => {
              setConflictState(null);
              void configQuery.refetch();
            }}
          >
            {t('cfg.conflict_reload')}
          </Button>,
        ]}
        onCancel={() => setConflictState(null)}
      >
        <Alert type="error" showIcon description={t('cfg.conflict_desc')} style={{ marginBottom: 16 }} />
      </Modal>

    </div>
  );
};
