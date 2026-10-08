import React from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import * as Lucide from 'lucide-react';

export * from 'lucide-react';

export interface AntdIconProps extends Omit<LucideProps, 'ref'> {
  spin?: boolean;
  rotate?: number;
}

export function createIcon(LucideComponent: LucideIcon, defaultClassName?: string) {
  const IconComponent = React.forwardRef<SVGSVGElement, AntdIconProps>((props, ref) => {
    const { spin, rotate, className, style, size = '1em', ...rest } = props;
    const combinedClassName = [
      'anticon',
      defaultClassName,
      spin ? 'anticon-spin' : '',
      className,
    ].filter(Boolean).join(' ');

    const combinedStyle: React.CSSProperties = {
      ...(rotate ? { transform: `rotate(${rotate}deg)` } : {}),
      ...style,
    };

    return (
      <LucideComponent
        ref={ref}
        size={size}
        className={combinedClassName}
        style={combinedStyle}
        {...rest}
      />
    );
  });
  IconComponent.displayName = LucideComponent.displayName || 'Icon';
  return IconComponent;
}

const SpinningLoader = createIcon(Lucide.LoaderCircle, 'anticon-loading');

export const ApiOutlined = createIcon(Lucide.Plug, 'anticon-api');
export const AppstoreOutlined = createIcon(Lucide.LayoutGrid, 'anticon-appstore');
export const ArrowDownOutlined = createIcon(Lucide.ArrowDown, 'anticon-arrow-down');
export const ArrowLeftOutlined = createIcon(Lucide.ArrowLeft, 'anticon-arrow-left');
export const ArrowRightOutlined = createIcon(Lucide.ArrowRight, 'anticon-arrow-right');
export const ArrowUpOutlined = createIcon(Lucide.ArrowUp, 'anticon-arrow-up');
export const AuditOutlined = createIcon(Lucide.ScrollText, 'anticon-audit');
export const BarChartOutlined = createIcon(Lucide.BarChart3, 'anticon-bar-chart');
export const BlockOutlined = createIcon(Lucide.Boxes, 'anticon-block');
export const BoxOutlined = createIcon(Lucide.Box, 'anticon-box');
export const BranchesOutlined = createIcon(Lucide.GitBranch, 'anticon-branches');
export const BugOutlined = createIcon(Lucide.Bug, 'anticon-bug');
export const BulbOutlined = createIcon(Lucide.Lightbulb, 'anticon-bulb');
export const CaretDownOutlined = createIcon(Lucide.ChevronDown, 'anticon-caret-down');
export const CheckCircleOutlined = createIcon(Lucide.CheckCircle2, 'anticon-check-circle');
export const CheckOutlined = createIcon(Lucide.Check, 'anticon-check');
export const CheckSquareOutlined = createIcon(Lucide.ListChecks, 'anticon-check-square');
export const ClearOutlined = createIcon(Lucide.Eraser, 'anticon-clear');
export const ClockCircleOutlined = createIcon(Lucide.Clock, 'anticon-clock-circle');
export const CloseCircleOutlined = createIcon(Lucide.XCircle, 'anticon-close-circle');
export const CloseOutlined = createIcon(Lucide.X, 'anticon-close');
export const CloudDownloadOutlined = createIcon(Lucide.CloudDownload, 'anticon-cloud-download');
export const CloudServerOutlined = createIcon(Lucide.Server, 'anticon-cloud-server');
export const CodeOutlined = createIcon(Lucide.Code, 'anticon-code');
export const CodeSandboxOutlined = createIcon(Lucide.SquareTerminal, 'anticon-code-sandbox');
export const CompassOutlined = createIcon(Lucide.Compass, 'anticon-compass');
export const CloudUploadOutlined = createIcon(Lucide.CloudUpload, 'anticon-cloud-upload');
export const CompressOutlined = createIcon(Lucide.Minimize2, 'anticon-compress');
export const ControlOutlined = createIcon(Lucide.Sliders, 'anticon-control');
export const CopyOutlined = createIcon(Lucide.Copy, 'anticon-copy');
export const DashboardOutlined = createIcon(Lucide.LayoutDashboard, 'anticon-dashboard');
export const DatabaseOutlined = createIcon(Lucide.Database, 'anticon-database');
export const DeleteOutlined = createIcon(Lucide.Trash2, 'anticon-delete');
export const DesktopOutlined = createIcon(Lucide.Monitor, 'anticon-desktop');
export const DollarOutlined = createIcon(Lucide.DollarSign, 'anticon-dollar');
export const DownOutlined = createIcon(Lucide.ChevronDown, 'anticon-down');
export const DownloadOutlined = createIcon(Lucide.Download, 'anticon-download');
export const EditOutlined = createIcon(Lucide.Pencil, 'anticon-edit');
export const ExclamationCircleOutlined = createIcon(Lucide.AlertCircle, 'anticon-exclamation-circle');
export const ExternalLinkOutlined = createIcon(Lucide.ExternalLink, 'anticon-external-link');
export const ExperimentOutlined = createIcon(Lucide.FlaskConical, 'anticon-experiment');
export const EyeInvisibleOutlined = createIcon(Lucide.EyeOff, 'anticon-eye-invisible');
export const EyeOutlined = createIcon(Lucide.Eye, 'anticon-eye');
export const FieldTimeOutlined = createIcon(Lucide.Timer, 'anticon-field-time');
export const FileTextOutlined = createIcon(Lucide.FileText, 'anticon-file-text');
export const FilterOutlined = createIcon(Lucide.Filter, 'anticon-filter');
export const FireOutlined = createIcon(Lucide.Flame, 'anticon-fire');
export const FormatPainterOutlined = createIcon(Lucide.Paintbrush, 'anticon-format-painter');
export const FullscreenExitOutlined = createIcon(Lucide.Minimize, 'anticon-fullscreen-exit');
export const FullscreenOutlined = createIcon(Lucide.Maximize, 'anticon-fullscreen');
export const ToolOutlined = createIcon(Lucide.Wrench, 'anticon-tool');
export const WrapTextOutlined = createIcon(Lucide.WrapText, 'anticon-wrap-text');
export const GlobalOutlined = createIcon(Lucide.Globe, 'anticon-global');
export const HistoryOutlined = createIcon(Lucide.History, 'anticon-history');
export const InfoCircleOutlined = createIcon(Lucide.Info, 'anticon-info-circle');
export const KeyOutlined = createIcon(Lucide.Key, 'anticon-key');
export const LayersOutlined = createIcon(Lucide.Layers, 'anticon-layers');
export const LayoutOutlined = createIcon(Lucide.PanelRight, 'anticon-layout');
export const LeftOutlined = createIcon(Lucide.ChevronLeft, 'anticon-left');
export const LineChartOutlined = createIcon(Lucide.ChartLine, 'anticon-line-chart');
export const LinkOutlined = createIcon(Lucide.Link, 'anticon-link');
export const LoadingOutlined = (props: AntdIconProps) => <SpinningLoader spin {...props} />;
export const LockOutlined = createIcon(Lucide.Lock, 'anticon-lock');
export const LoginOutlined = createIcon(Lucide.LogIn, 'anticon-login');
export const LogoutOutlined = createIcon(Lucide.LogOut, 'anticon-logout');
export const MenuFoldOutlined = createIcon(Lucide.PanelLeftClose, 'anticon-menu-fold');
export const MenuUnfoldOutlined = createIcon(Lucide.PanelLeftOpen, 'anticon-menu-unfold');
export const MessageOutlined = createIcon(Lucide.MessageSquarePlus, 'anticon-message');
export const StepsOutlined = createIcon(Lucide.ListTree, 'anticon-steps');
export const MoonOutlined = createIcon(Lucide.Moon, 'anticon-moon');
// A request answered in one payload. A struck broadcast mark, because the stream is what is absent;
// the boxes glyph belongs to Model Square.
export const NonStreamOutlined = createIcon(Lucide.RadioOff, 'anticon-non-stream');
export const MoreOutlined = createIcon(Lucide.MoreHorizontal, 'anticon-more');
export const NodeIndexOutlined = createIcon(Lucide.Network, 'anticon-node-index');
export const PauseCircleOutlined = createIcon(Lucide.PauseCircle, 'anticon-pause-circle');
export const PaperClipOutlined = createIcon(Lucide.Paperclip, 'anticon-paper-clip');
export const PictureOutlined = createIcon(Lucide.Image, 'anticon-picture');
export const PuzzleOutlined = createIcon(Lucide.Puzzle, 'anticon-puzzle');
export const PlayCircleOutlined = createIcon(Lucide.PlayCircle, 'anticon-play-circle');
export const PlusOutlined = createIcon(Lucide.Plus, 'anticon-plus');
export const ProfileOutlined = createIcon(Lucide.FileText, 'anticon-profile');
export const QuestionCircleOutlined = createIcon(Lucide.HelpCircle, 'anticon-question-circle');
export const QuoteOutlined = createIcon(Lucide.TextQuote, 'anticon-quote');
export const ReloadOutlined = createIcon(Lucide.RotateCw, 'anticon-reload');
export const RightOutlined = createIcon(Lucide.ChevronRight, 'anticon-right');
export const RobotOutlined = createIcon(Lucide.Bot, 'anticon-robot');
export const RocketOutlined = createIcon(Lucide.Rocket, 'anticon-rocket');
export const RollbackOutlined = createIcon(Lucide.RotateCcw, 'anticon-rollback');
export const SafetyCertificateOutlined = createIcon(Lucide.ShieldCheck, 'anticon-safety-certificate');
export const SaveOutlined = createIcon(Lucide.Save, 'anticon-save');
export const SearchOutlined = createIcon(Lucide.Search, 'anticon-search');
export const SettingOutlined = createIcon(Lucide.Settings, 'anticon-setting');
export const ShopOutlined = createIcon(Lucide.Store, 'anticon-shop');
export const SlidersOutlined = createIcon(Lucide.SlidersHorizontal, 'anticon-sliders');
export const StopOutlined = createIcon(Lucide.Square, 'anticon-stop');
export const SunOutlined = createIcon(Lucide.Sun, 'anticon-sun');
export const SyncOutlined = createIcon(Lucide.RefreshCw, 'anticon-sync');
export const TableOutlined = createIcon(Lucide.Table2, 'anticon-table');
export const TagOutlined = createIcon(Lucide.Tag, 'anticon-tag');
export const ThunderboltFilled = createIcon(Lucide.Zap, 'anticon-thunderbolt');
export const ThunderboltOutlined = createIcon(Lucide.Zap, 'anticon-thunderbolt');
export const UndoOutlined = createIcon(Lucide.Undo2, 'anticon-undo');
export const SwapOutlined = createIcon(Lucide.ArrowLeftRight, 'anticon-swap');
export const UpOutlined = createIcon(Lucide.ChevronUp, 'anticon-up');
export const UploadOutlined = createIcon(Lucide.Upload, 'anticon-upload');
export const VerticalAlignTopOutlined = createIcon(Lucide.ArrowUpToLine, 'anticon-vertical-align-top');
export const WarningOutlined = createIcon(Lucide.AlertTriangle, 'anticon-warning');

/**
 * The GitHub mark, drawn from Octicons' `mark-github` (MIT). Lucide no longer ships
 * brand marks, and a plugin's repository link is recognised by this glyph.
 */
export const GithubOutlined = React.forwardRef<SVGSVGElement, AntdIconProps>(({ className, style, size = '1em' }, ref) => (
  <svg
    ref={ref}
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="currentColor"
    aria-hidden="true"
    className={['anticon', 'anticon-github', className].filter(Boolean).join(' ')}
    style={style}
  >
    <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
  </svg>
));
GithubOutlined.displayName = 'GithubOutlined';
