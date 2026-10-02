import React from 'react';
import { Button, Input, InputNumber, Popconfirm, Tooltip } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckOutlined, UndoOutlined } from '../../components/icons';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { ResponsiveList } from '../../components/common/ResponsiveList';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import { pluginOAuthLogoFor, type PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import type { PricingChannel, PricingProvider } from '../../types/pricing';
import { channelIdentity } from '../../components/pricing/pricingIdentity';
import { PRICING_QUERY_KEYS } from '../../components/pricing/pricingQueries';
import { pricingErrorText } from '../../components/pricing/pricingErrors';
import { UsageCell } from './UsageCell';
import styles from './PricingPage.module.css';
import { useToast } from '../../components/feedback';

/**
 * Channel multipliers: what one CPA provider actually charges relative to list price. A relay
 * that resells at 30% is 0.3; a subscription counted at its API-equivalent value stays 1. The
 * list is every configured channel plus every channel the window's traffic used, so a channel
 * can be scaled the moment it shows up.
 */
export const ChannelMultipliersPanel: React.FC<{
  channels: PricingChannel[];
  providers: PricingProvider[];
  pluginLogos: PluginOAuthLogos;
  isLoading: boolean;
  isBlocked: boolean;
}> = ({ channels, providers, pluginLogos, isLoading, isBlocked }) => {
  const t = useT();
  const columns = [
    {
      title: t('pricing.channels.col.channel'),
      key: 'channel',
      render: (_: unknown, channel: PricingChannel) => {
        const identity = channelIdentity(channel.channel, providers);
        return (
          <div className={styles['model-cell']}>
            <ProviderBrandIcon iconId={identity.iconId} providerKeys={[channel.channel]} logo={pluginOAuthLogoFor(pluginLogos, channel.channel)} size={18} />
            <div className={styles['model-text']}>
              <span className={styles['model-name']}>{identity.label}</span>
              {identity.label !== channel.channel && <span className={styles['model-sub']}>{channel.channel}</span>}
            </div>
          </div>
        );
      },
    },
    {
      title: t('pricing.channels.col.multiplier'),
      key: 'multiplier',
      width: 320,
      render: (_: unknown, channel: PricingChannel) => <ChannelEditor channel={channel} label={channelIdentity(channel.channel, providers).label} />,
    },
    {
      title: t('pricing.col.usage'),
      key: 'usage',
      align: 'right' as const,
      width: 150,
      render: (_: unknown, channel: PricingChannel) => <UsageCell usage={channel.usage_30d} scope={{ key: 'provider', value: channel.channel }} />,
    },
  ];
  return (
    <section className={styles.workbench} data-testid="pricing-channels">
      <p className={styles['channels-formula']}>{t('pricing.channels.formula')}</p>
      <ResponsiveList<PricingChannel>
        columns={columns}
        dataSource={channels}
        rowKey="channel"
        pageSize={20}
        isLoading={isLoading}
        isBlocked={isBlocked}
        emptyText={t('pricing.channels.empty')}
        phone={{ identity: 'channel' }}
        tableProps={{ size: 'small' }}
      />
    </section>
  );
};

/**
 * One channel's multiplier and note, edited in its row. Saving applies to requests from now on;
 * that consequence is on the reset confirmation, the one action whose effect is easy to misread.
 */
const ChannelEditor: React.FC<{ channel: PricingChannel; label: string }> = ({ channel, label }) => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [multiplier, setMultiplier] = React.useState<number>(channel.multiplier);
  const [note, setNote] = React.useState(channel.note);
  React.useEffect(() => {
    setMultiplier(channel.multiplier);
    setNote(channel.note);
  }, [channel.multiplier, channel.note]);
  const isDirty = multiplier !== channel.multiplier || note !== channel.note || (!channel.is_configured && multiplier !== 1);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: PRICING_QUERY_KEYS.book });
  const save = useMutation({
    mutationFn: () => api.updatePricingChannel(channel.channel, { multiplier, note }),
    onSuccess: () => {
      toast.success(t('pricing.channels.saved', { channel: label }));
      refresh();
    },
    onError: (error) => toast.error(t('pricing.save_failed', { msg: pricingErrorText(t, error) })),
  });
  const reset = useMutation({
    mutationFn: () => api.deletePricingChannel(channel.channel),
    onSuccess: () => {
      toast.success(t('pricing.channels.reset_done', { channel: label }));
      refresh();
    },
    onError: (error) => toast.error(t('pricing.delete_failed', { msg: pricingErrorText(t, error) })),
  });
  return (
    <div className={styles['channel-editor']}>
      <InputNumber
        size="small"
        min={0.01}
        max={100}
        step={0.05}
        value={multiplier}
        onChange={(value) => setMultiplier(typeof value === 'number' && value > 0 ? value : 1)}
        suffix="×"
        className={styles['channel-multiplier']}
        aria-label={`${t('pricing.channels.col.multiplier')}: ${label}`}
        data-testid="pricing-channel-multiplier"
      />
      <Input
        size="small"
        value={note}
        maxLength={512}
        onChange={(event) => setNote(event.target.value)}
        placeholder={t('pricing.channels.note_placeholder')}
        aria-label={`${t('pricing.channels.col.note')}: ${label}`}
        className={styles['channel-note']}
      />
      <div className="row-actions">
        <Tooltip title={t('common.save')}>
          <Button
            size="small"
            className="row-action-btn"
            icon={<CheckOutlined />}
            disabled={!isDirty}
            loading={save.isPending}
            onClick={() => save.mutate()}
            aria-label={`${t('common.save')}: ${label}`}
            data-testid="pricing-channel-save"
          />
        </Tooltip>
        {channel.is_configured && (
          <Popconfirm
            title={t('pricing.channels.reset_confirm', { channel: label })}
            okText={t('pricing.channels.reset')}
            cancelText={t('common.cancel')}
            onConfirm={() => reset.mutate()}
          >
            <Tooltip title={t('pricing.channels.reset')}>
              <Button
                size="small"
                className="row-action-btn"
                icon={<UndoOutlined />}
                loading={reset.isPending}
                aria-label={`${t('pricing.channels.reset')}: ${label}`}
              />
            </Tooltip>
          </Popconfirm>
        )}
      </div>
    </div>
  );
};
