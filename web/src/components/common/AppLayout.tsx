import React from 'react';
import { Outlet } from 'react-router-dom';
import { HeaderNav } from './HeaderNav';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { message } from 'antd';

export const AppLayout: React.FC = () => {
  const queryClient = useQueryClient();

  // Polling healthz probe
  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: api.getHealth,
    refetchInterval: 15000,
  });

  // Query unclaimed count for the header badge
  const { data: unclaimedData } = useQuery({
    queryKey: ['resources', 'unclaimed'],
    queryFn: () => api.getResources({ status: 'unclaimed' }),
  });

  const logoutMutation = useMutation({
    mutationFn: api.logout,
    onSuccess: () => window.location.reload(),
    onError: (err: Error) => message.error(`退出登录失败: ${err.message}`),
  });

  // Discovery mutation
  const discoverMutation = useMutation({
    mutationFn: api.discoverDefaultInstance,
    onSuccess: (result) => {
      message.success(
        `扫描成功！发现 ${result.discovered_count} 个 CPA 端点 (待整理: ${result.unclaimed_count})`
      );
      queryClient.invalidateQueries({ queryKey: ['resources'] });
    },
    onError: (err: Error) => {
      message.error(`扫描 CPA 实例失败: ${err.message}`);
    },
  });

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#f8fafc' }}>
      <HeaderNav
        unclaimedCount={unclaimedData?.total ?? 0}
        health={health}
        isDiscovering={discoverMutation.isPending}
        onDiscover={() => discoverMutation.mutate()}
        onLogout={() => logoutMutation.mutate()}
        isLoggingOut={logoutMutation.isPending}
      />

      <main style={{ flex: 1, padding: '24px', maxWidth: '1280px', width: '100%', margin: '0 auto' }}>
        <Outlet context={{ triggerDiscovery: () => discoverMutation.mutate(), isDiscovering: discoverMutation.isPending }} />
      </main>

      <footer
        style={{
          borderTop: '1px solid #e2e8f0',
          padding: '20px 24px',
          textAlign: 'center',
          backgroundColor: '#ffffff',
          color: '#64748b',
          fontSize: '13px',
        }}
      >
        <div style={{ maxWidth: '1280px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span><strong>Oh My CPA</strong> · Make CPA yours. 面向 CLIProxyAPI 的 AI 资产管理中心</span>
          <span style={{ fontSize: '12px', color: '#94a3b8' }}>
            与 OpenAI, Anthropic, Google 及 CPA 上游无隶属关系
          </span>
        </div>
      </footer>
    </div>
  );
};
