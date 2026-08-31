import React from 'react';
import { Button, Tag, Tooltip, Badge } from 'antd';
import {
  SyncOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  AppstoreOutlined,
  FolderOpenOutlined,
  ClusterOutlined,
} from '@ant-design/icons';
import { NavLink } from 'react-router-dom';
import { getAppConfig } from '../../types/config';
import { HealthStatus } from '../../types/resource';

// Header navigation component

interface HeaderNavProps {
  unclaimedCount?: number;
  health?: HealthStatus;
  isDiscovering?: boolean;
  onDiscover?: () => void;
}

export const HeaderNav: React.FC<HeaderNavProps> = ({
  unclaimedCount = 0,
  health,
  isDiscovering = false,
  onDiscover,
}) => {
  const config = getAppConfig();

  const isOnline = health?.status === 'ok' || health?.status === 'healthy';

  return (
    <header
      style={{
        backgroundColor: '#ffffff',
        borderBottom: '1px solid #e2e8f0',
        position: 'sticky',
        top: 0,
        zIndex: 100,
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.02)',
      }}
    >
      <div
        style={{
          maxWidth: '1280px',
          margin: '0 auto',
          padding: '0 24px',
          height: '64px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        {/* Left: Brand Identity & Nav Links */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
          {/* Logo & Title */}
          <NavLink
            to="/"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              textDecoration: 'none',
            }}
          >
            <div
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #1677FF 0%, #722ED1 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ffffff',
                fontWeight: 700,
                fontSize: '16px',
                boxShadow: '0 2px 8px rgba(22, 119, 255, 0.3)',
              }}
            >
              Ω
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                  style={{
                    fontSize: '18px',
                    fontWeight: 700,
                    color: '#0f172a',
                    letterSpacing: '-0.3px',
                  }}
                >
                  Oh My CPA
                </span>
                <Tag
                  color="blue"
                  style={{
                    margin: 0,
                    fontSize: '10px',
                    lineHeight: '16px',
                    padding: '0 4px',
                    borderRadius: '4px',
                    fontWeight: 600,
                  }}
                >
                  v0.1
                </Tag>
              </div>
              <span style={{ fontSize: '11px', color: '#64748b', display: 'block', lineHeight: 1 }}>
                AI 订阅、账号与接入管理
              </span>
            </div>
          </NavLink>

          {/* Navigation Links */}
          <nav style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <NavLink
              to="/"
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: isActive ? 600 : 500,
                color: isActive ? '#1677FF' : '#475569',
                backgroundColor: isActive ? '#e6f4ff' : 'transparent',
                textDecoration: 'none',
                transition: 'all 0.2s ease',
              })}
            >
              <FolderOpenOutlined />
              <span>待整理</span>
              {unclaimedCount > 0 && (
                <Badge
                  count={unclaimedCount}
                  overflowCount={99}
                  style={{
                    backgroundColor: '#FA8C16',
                    fontSize: '11px',
                    height: '18px',
                    lineHeight: '18px',
                  }}
                />
              )}
            </NavLink>

            <NavLink
              to="/all"
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: isActive ? 600 : 500,
                color: isActive ? '#1677FF' : '#475569',
                backgroundColor: isActive ? '#e6f4ff' : 'transparent',
                textDecoration: 'none',
                transition: 'all 0.2s ease',
              })}
            >
              <AppstoreOutlined />
              <span>所有资源</span>
            </NavLink>

            <NavLink
              to="/instances"
              className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 14px',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: isActive ? 600 : 500,
                color: isActive ? '#1677FF' : '#475569',
                backgroundColor: isActive ? '#e6f4ff' : 'transparent',
                textDecoration: 'none',
                transition: 'all 0.2s ease',
              })}
            >
              <ClusterOutlined />
              <span>CPA 实例</span>
            </NavLink>
          </nav>
        </div>

        {/* Right: Actions & Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Base Path Indicator */}
          <Tooltip title={`当前挂载子路径：${config.basePath || '/'}`}>
            <Tag style={{ margin: 0, fontFamily: 'monospace', fontSize: '11px', color: '#64748b' }}>
              Base: {config.basePath || '/'}
            </Tag>
          </Tooltip>

          {/* Health Status Indicator */}
          <Tooltip
            title={
              isOnline
                ? `Oh My CPA 运行正常 ${health?.version ? `(${health.version})` : ''}`
                : '后端服务连接中或离线'
            }
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                borderRadius: '16px',
                backgroundColor: isOnline ? '#f6ffed' : '#fff1f0',
                border: isOnline ? '1px solid #b7eb8f' : '1px solid #ffa39e',
                fontSize: '12px',
                color: isOnline ? '#389e0d' : '#cf1322',
              }}
            >
              {isOnline ? (
                <CheckCircleFilled style={{ color: '#52c41a' }} />
              ) : (
                <CloseCircleFilled style={{ color: '#ff4d4f' }} />
              )}
              <span>{isOnline ? '正常运行' : '离线/重试'}</span>
            </div>
          </Tooltip>

          {/* Trigger Discovery / Sync Button */}
          <Button
            type="primary"
            icon={isDiscovering ? <LoadingOutlined /> : <SyncOutlined />}
            loading={isDiscovering}
            onClick={onDiscover}
            style={{ borderRadius: '6px', fontWeight: 500 }}
          >
            扫描 / 同步 CPA
          </Button>
        </div>
      </div>
    </header>
  );
};
