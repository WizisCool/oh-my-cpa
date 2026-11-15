import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '../../components/common/NumberInput';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckOutlined, RightOutlined, UndoOutlined } from '../../components/icons';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { ResponsiveList } from '../../components/common/ResponsiveList';
import { ProviderBrandIcon } from '../../components/LobeIcon';
import type { ProviderBrandSources } from '../../types/brandMark';
import type { ModelPrice, PricingChannel, PricingProvider } from '../../types/pricing';
import { multiplierDelta } from '../../types/pricingBook';
import { channelIdentity } from '../../components/pricing/pricingIdentity';
import { PRICING_QUERY_KEYS } from '../../components/pricing/pricingQueries';
import { pricingErrorText } from '../../components/pricing/pricingErrors';
import { UsageCell } from './UsageCell';
import styles from './PricingPage.module.css';
import { useToast } from '../../components/feedback';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { Tooltip } from '../../components/common/Tooltip';

/**
 * Channel multipliers: what one CPA provider actually charges relative to list price. A relay
 * that resells at 30% is 0.3; a subscription counted at its API-equivalent value stays 1. The
 * list is every configured channel plus every channel the window's traffic used, so a channel
 * can be scaled the moment it shows up. A channel's own model prices are counted here and listed
 * on the model tab, where they are edited.
 */
export const ChannelMultipliersPanel: React.FC<{
  channels: PricingChannel[];
  providers: PricingProvider[];
  branding: ProviderBrandSources;
  ownPrices: ModelPrice[];
  isLoading: boolean;
  isBlocked: boolean;
  onShowModels: (channel: string) => void;
}> = ({ channels, providers, branding, ownPrices, isLoading, isBlocked, onShowModels }) => {
  const t = useT();
  const ownCount = (channel: string) => ownPrices.filter((price) => price.channel === channel).length;
  const columns = [
    {
      title: t('pricing.channels.col.channel'),
      key: 'channel',
      render: (_: unknown, channel: PricingChannel) => {
        const identity = channelIdentity(channel.channel, providers, branding);
        return (
          <div className={styles['model-cell']}>
            <ProviderBrandIcon mark={identity} size={18} />
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
      width: 420,
      render: (_: unknown, channel: PricingChannel) => <ChannelEditor channel={channel} label={channelIdentity(channel.channel, providers, branding).label} />,
    },
    {
      title: t('pricing.channels.col.own_prices'),
      key: 'own',
      width: 120,
      render: (_: unknown, channel: PricingChannel) => {
        const count = ownCount(channel.channel);
        return count === 0 ? <span className={styles.dimmed}>—</span> : (
          <Button size="sm" variant="link" className={styles['own-prices']} onClick={() => onShowModels(channel.channel)} data-testid="pricing-channel-own-prices">
            {t('pricing.channels.own_prices', { n: count })}
            <RightOutlined />
          </Button>
        );
      },
    },
    {
      title: t('pricing.col.usage'),
      key: 'usage',
      align: 'right' as const,
      width: 180,
      render: (_: unknown, channel: PricingChannel) => <UsageCell usage={channel.usage_30d} scope={{ key: 'provider', value: channel.channel }} />,
    },
  ];
  return (
    <section className={styles.workbench} data-testid="pricing-channels">
      <ResponsiveList<PricingChannel>
        columns={columns}
        dataSource={channels}
        rowKey="channel"
        pageSize={20}
        isLoading={isLoading}
        isBlocked={isBlocked}
        emptyText={t('pricing.channels.empty')}
        phone={{ identity: 'channel' }}
        tableProps={{ scroll: { x: 'max-content' } }}
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
  const delta = multiplierDelta(multiplier);
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
      <NumberInput
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
      {/* The multiplier read as a discount or a markup, live as it is typed; list price reads as nothing. */}
      <span className={styles['multiplier-delta']} aria-live="polite" data-testid="pricing-channel-delta">
        {delta === null ? '' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`}
      </span>
      <Input
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
            size="sm"
            variant="ghost" className="row-action-btn"
            icon={<CheckOutlined />}
            disabled={!isDirty}
            loading={save.isPending}
            onClick={() => save.mutate()}
            aria-label={`${t('common.save')}: ${label}`}
            data-testid="pricing-channel-save"
          />
        </Tooltip>
        {channel.is_configured && (
          <ConfirmAction
            title={t('pricing.channels.reset_confirm', { channel: label })}
            confirmLabel={t('pricing.channels.reset')}
            onConfirm={() => reset.mutate()}
            tooltip={t('pricing.channels.reset')}
          >
            <Button
              size="sm"
              variant="ghost" className="row-action-btn"
              icon={<UndoOutlined />}
              loading={reset.isPending}
              aria-label={`${t('pricing.channels.reset')}: ${label}`}
            />
          </ConfirmAction>
        )}
      </div>
    </div>
  );
};
