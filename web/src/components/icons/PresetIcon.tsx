import React from 'react';
import {
  CodeOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  SafetyCertificateOutlined,
  CompassOutlined,
  RocketOutlined,
  FireOutlined,
  SlidersOutlined,
  GlobalOutlined,
} from '@ant-design/icons';

interface PresetIconProps {
  name?: string | null;
  className?: string;
  style?: React.CSSProperties;
  size?: number;
}

export const PresetIcon: React.FC<PresetIconProps> = ({
  name,
  className,
  style,
  size = 20,
}) => {
  const iconKey = (name || 'custom').toLowerCase().trim();

  const iconStyle: React.CSSProperties = {
    fontSize: `${size}px`,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    ...style,
  };

  switch (iconKey) {
    case 'deepseek':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          {/* Stylized whale/intelligence icon */}
          <path d="M3 13c2.5-3 5-4.5 8-4.5 4 0 7 2 9 6-2 3-5 5.5-9 5.5-3 0-5.5-1.5-8-7z" />
          <circle cx="8" cy="12" r="1.5" fill="currentColor" />
          <path d="M14 8.5c1-2 3-3 5-2.5" />
        </svg>
      );

    case 'openai':
    case 'chatgpt':
    case 'gpt':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          {/* OpenAI spiral emblem */}
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 7.8 4.5" />
          <path d="M21 12a9 9 0 0 1-4.5 7.8" />
          <path d="M12 21a9 9 0 0 1-7.8-4.5" />
          <path d="M3 12a9 9 0 0 1 4.5-7.8" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );

    case 'claude':
    case 'anthropic':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          {/* Claude starburst / facet icon */}
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );

    case 'gemini':
    case 'google':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          {/* Sparkle 4-point star */}
          <path d="M12 2v20M2 12h20M5 5l14 14M19 5L5 19" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="4" fill="currentColor" fillOpacity="0.2" />
        </svg>
      );

    case 'goat':
    case 'commandcode':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          {/* Crown / GOAT horn silhouette */}
          <path d="M4 19h16M5 15l2-8 5 4 5-4 2 8H5z" />
          <circle cx="12" cy="7" r="1" fill="currentColor" />
        </svg>
      );

    case 'opencode':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          style={style}
        >
          <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
          <path d="M12 4v16" strokeDasharray="2 2" />
        </svg>
      );

    case 'relay':
    case 'proxy':
      return <GlobalOutlined style={iconStyle} className={className} />;

    case 'code':
      return <CodeOutlined style={iconStyle} className={className} />;

    case 'shield':
      return <SafetyCertificateOutlined style={iconStyle} className={className} />;

    case 'sparkles':
      return <FireOutlined style={iconStyle} className={className} />;

    case 'bolt':
      return <ThunderboltOutlined style={iconStyle} className={className} />;

    case 'rocket':
      return <RocketOutlined style={iconStyle} className={className} />;

    case 'compass':
      return <CompassOutlined style={iconStyle} className={className} />;

    case 'api':
      return <ApiOutlined style={iconStyle} className={className} />;

    case 'custom':
    default:
      return <SlidersOutlined style={iconStyle} className={className} />;
  }
};
