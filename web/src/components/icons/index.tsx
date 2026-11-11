import React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ArrowUpToLine,
  Ban,
  BarChart3,
  Bell,
  BellOff,
  Bot,
  Box,
  Boxes,
  Bug,
  Cable,
  ChartLine,
  ChartNoAxesCombined,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleArrowUp,
  Clock,
  Cloud,
  CloudDownload,
  CloudUpload,
  Code,
  Compass,
  Copy,
  Database,
  DollarSign,
  Download,
  Eraser,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Filter,
  Flame,
  FlaskConical,
  GitBranch,
  Globe,
  GripVertical,
  HelpCircle,
  History,
  Hourglass,
  Image,
  Info,
  Key,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Lightbulb,
  Link,
  List,
  ListChecks,
  ListTree,
  LoaderCircle,
  Lock,
  LogIn,
  LogOut,
  Maximize,
  MessageSquarePlus,
  Minimize,
  Minimize2,
  Monitor,
  Moon,
  MoreHorizontal,
  Network,
  PackageSearch,
  Paintbrush,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Paperclip,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plug,
  Plus,
  Puzzle,
  RadioOff,
  ReceiptText,
  RefreshCw,
  Rocket,
  RotateCcw,
  RotateCw,
  Save,
  ScrollText,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sliders,
  SlidersHorizontal,
  SquareTerminal,
  Star,
  StickyNote,
  Store,
  Sun,
  Table2,
  Tag,
  TextCursorInput,
  TextQuote,
  Timer,
  TimerReset,
  Trash2,
  Undo2,
  Upload,
  Wrench,
  WrapText,
  X,
  XCircle,
  Zap,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';

export { Star, type LucideIcon, type LucideProps };

export interface AntdIconProps extends Omit<LucideProps, 'ref'> {
  spin?: boolean;
  rotate?: number;
}

export /*#__PURE__*/ function createIcon(LucideComponent: LucideIcon, defaultClassName?: string) {
  return React.forwardRef<SVGSVGElement, AntdIconProps>(function AntdCompatIcon(props, ref) {
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
}

const SpinningLoader = /*#__PURE__*/ createIcon(LoaderCircle, 'anticon-loading');

export const ApiOutlined = /*#__PURE__*/ createIcon(Plug, 'anticon-api');
export const AppstoreOutlined = /*#__PURE__*/ createIcon(LayoutGrid, 'anticon-appstore');
export const ArrowDownOutlined = /*#__PURE__*/ createIcon(ArrowDown, 'anticon-arrow-down');
export const ArrowLeftOutlined = /*#__PURE__*/ createIcon(ArrowLeft, 'anticon-arrow-left');
export const ArrowRightOutlined = /*#__PURE__*/ createIcon(ArrowRight, 'anticon-arrow-right');
export const ArrowUpOutlined = /*#__PURE__*/ createIcon(ArrowUp, 'anticon-arrow-up');
export const AuditOutlined = /*#__PURE__*/ createIcon(ScrollText, 'anticon-audit');
export const BarChartOutlined = /*#__PURE__*/ createIcon(BarChart3, 'anticon-bar-chart');
export const BlockOutlined = /*#__PURE__*/ createIcon(Boxes, 'anticon-block');
export const BoxOutlined = /*#__PURE__*/ createIcon(Box, 'anticon-box');
export const BranchesOutlined = /*#__PURE__*/ createIcon(GitBranch, 'anticon-branches');
export const BugOutlined = /*#__PURE__*/ createIcon(Bug, 'anticon-bug');
export const BulbOutlined = /*#__PURE__*/ createIcon(Lightbulb, 'anticon-bulb');
export const CaretDownOutlined = /*#__PURE__*/ createIcon(ChevronDown, 'anticon-caret-down');
export const CheckCircleOutlined = /*#__PURE__*/ createIcon(CheckCircle2, 'anticon-check-circle');
export const CheckOutlined = /*#__PURE__*/ createIcon(Check, 'anticon-check');
export const CheckSquareOutlined = /*#__PURE__*/ createIcon(ListChecks, 'anticon-check-square');
export const ClearOutlined = /*#__PURE__*/ createIcon(Eraser, 'anticon-clear');
export const ClockCircleOutlined = /*#__PURE__*/ createIcon(Clock, 'anticon-clock-circle');
export const CloseCircleOutlined = /*#__PURE__*/ createIcon(XCircle, 'anticon-close-circle');
export const CloseOutlined = /*#__PURE__*/ createIcon(X, 'anticon-close');
export const BellOutlined = /*#__PURE__*/ createIcon(Bell, 'anticon-bell');
export const BellOffOutlined = /*#__PURE__*/ createIcon(BellOff, 'anticon-bell-off');
export const CloudDownloadOutlined = /*#__PURE__*/ createIcon(CloudDownload, 'anticon-cloud-download');
export const CloudServerOutlined = /*#__PURE__*/ createIcon(Server, 'anticon-cloud-server');
export const CloudOutlined = /*#__PURE__*/ createIcon(Cloud, 'anticon-cloud');
export const CodeOutlined = /*#__PURE__*/ createIcon(Code, 'anticon-code');
export const CodeSandboxOutlined = /*#__PURE__*/ createIcon(SquareTerminal, 'anticon-code-sandbox');
export const CompassOutlined = /*#__PURE__*/ createIcon(Compass, 'anticon-compass');
export const CloudUploadOutlined = /*#__PURE__*/ createIcon(CloudUpload, 'anticon-cloud-upload');
export const CompressOutlined = /*#__PURE__*/ createIcon(Minimize2, 'anticon-compress');
export const ControlOutlined = /*#__PURE__*/ createIcon(Sliders, 'anticon-control');
export const CopyOutlined = /*#__PURE__*/ createIcon(Copy, 'anticon-copy');
export const DashboardOutlined = /*#__PURE__*/ createIcon(LayoutDashboard, 'anticon-dashboard');
export const DatabaseOutlined = /*#__PURE__*/ createIcon(Database, 'anticon-database');
export const DeleteOutlined = /*#__PURE__*/ createIcon(Trash2, 'anticon-delete');
export const DesktopOutlined = /*#__PURE__*/ createIcon(Monitor, 'anticon-desktop');
export const DollarOutlined = /*#__PURE__*/ createIcon(DollarSign, 'anticon-dollar');
export const DownOutlined = /*#__PURE__*/ createIcon(ChevronDown, 'anticon-down');
export const DownloadOutlined = /*#__PURE__*/ createIcon(Download, 'anticon-download');
export const EditOutlined = /*#__PURE__*/ createIcon(Pencil, 'anticon-edit');
export const ExclamationCircleOutlined = /*#__PURE__*/ createIcon(AlertCircle, 'anticon-exclamation-circle');
export const ExternalLinkOutlined = /*#__PURE__*/ createIcon(ExternalLink, 'anticon-external-link');
export const ExperimentOutlined = /*#__PURE__*/ createIcon(FlaskConical, 'anticon-experiment');
export const EyeInvisibleOutlined = /*#__PURE__*/ createIcon(EyeOff, 'anticon-eye-invisible');
export const EyeOutlined = /*#__PURE__*/ createIcon(Eye, 'anticon-eye');
export const FieldTimeOutlined = /*#__PURE__*/ createIcon(Timer, 'anticon-field-time');
export const FileTextOutlined = /*#__PURE__*/ createIcon(FileText, 'anticon-file-text');
export const FilterOutlined = /*#__PURE__*/ createIcon(Filter, 'anticon-filter');
export const FireOutlined = /*#__PURE__*/ createIcon(Flame, 'anticon-fire');
export const FormatPainterOutlined = /*#__PURE__*/ createIcon(Paintbrush, 'anticon-format-painter');
export const FullscreenExitOutlined = /*#__PURE__*/ createIcon(Minimize, 'anticon-fullscreen-exit');
export const FullscreenOutlined = /*#__PURE__*/ createIcon(Maximize, 'anticon-fullscreen');
export const ToolOutlined = /*#__PURE__*/ createIcon(Wrench, 'anticon-tool');
export const WrapTextOutlined = /*#__PURE__*/ createIcon(WrapText, 'anticon-wrap-text');
export const GlobalOutlined = /*#__PURE__*/ createIcon(Globe, 'anticon-global');
export const HistoryOutlined = /*#__PURE__*/ createIcon(History, 'anticon-history');
export const HourglassOutlined = /*#__PURE__*/ createIcon(Hourglass, 'anticon-hourglass');
export const HolderOutlined = /*#__PURE__*/ createIcon(GripVertical, 'anticon-holder');
export const InsightsOutlined = /*#__PURE__*/ createIcon(ChartNoAxesCombined, 'anticon-insights');
export const InfoCircleOutlined = /*#__PURE__*/ createIcon(Info, 'anticon-info-circle');
export const KeyOutlined = /*#__PURE__*/ createIcon(Key, 'anticon-key');
export const LayersOutlined = /*#__PURE__*/ createIcon(Layers, 'anticon-layers');
export const LayoutOutlined = /*#__PURE__*/ createIcon(PanelRight, 'anticon-layout');
export const LeftOutlined = /*#__PURE__*/ createIcon(ChevronLeft, 'anticon-left');
export const LineChartOutlined = /*#__PURE__*/ createIcon(ChartLine, 'anticon-line-chart');
export const ListOutlined = /*#__PURE__*/ createIcon(List, 'anticon-list');
export const LinkOutlined = /*#__PURE__*/ createIcon(Link, 'anticon-link');
export const LoadingOutlined = (props: AntdIconProps) => <SpinningLoader spin {...props} />;
export const LockOutlined = /*#__PURE__*/ createIcon(Lock, 'anticon-lock');
export const LoginOutlined = /*#__PURE__*/ createIcon(LogIn, 'anticon-login');
export const LogoutOutlined = /*#__PURE__*/ createIcon(LogOut, 'anticon-logout');
export const MenuFoldOutlined = /*#__PURE__*/ createIcon(PanelLeftClose, 'anticon-menu-fold');
export const MenuUnfoldOutlined = /*#__PURE__*/ createIcon(PanelLeftOpen, 'anticon-menu-unfold');
export const MessageOutlined = /*#__PURE__*/ createIcon(MessageSquarePlus, 'anticon-message');
export const StepsOutlined = /*#__PURE__*/ createIcon(ListTree, 'anticon-steps');
export const MoonOutlined = /*#__PURE__*/ createIcon(Moon, 'anticon-moon');
// A request answered in one payload. A struck broadcast mark, because the stream is what is absent;
// the boxes glyph belongs to Model Square.
export const NonStreamOutlined = /*#__PURE__*/ createIcon(RadioOff, 'anticon-non-stream');
// A request carried over an upstream WebSocket: a held connection, so a cable rather than a broadcast.
export const WebsocketOutlined = /*#__PURE__*/ createIcon(Cable, 'anticon-websocket');
export const MoreOutlined = /*#__PURE__*/ createIcon(MoreHorizontal, 'anticon-more');
export const NodeIndexOutlined = /*#__PURE__*/ createIcon(Network, 'anticon-node-index');
export const PauseCircleOutlined = /*#__PURE__*/ createIcon(PauseCircle, 'anticon-pause-circle');
export const PaperClipOutlined = /*#__PURE__*/ createIcon(Paperclip, 'anticon-paper-clip');
export const PictureOutlined = /*#__PURE__*/ createIcon(Image, 'anticon-picture');
export const NoteOutlined = /*#__PURE__*/ createIcon(StickyNote, 'anticon-note');
export const PackageSearchOutlined = /*#__PURE__*/ createIcon(PackageSearch, 'anticon-package-search');
export const PuzzleOutlined = /*#__PURE__*/ createIcon(Puzzle, 'anticon-puzzle');
export const PlayCircleOutlined = /*#__PURE__*/ createIcon(PlayCircle, 'anticon-play-circle');
export const PlusOutlined = /*#__PURE__*/ createIcon(Plus, 'anticon-plus');
export const ProfileOutlined = /*#__PURE__*/ createIcon(FileText, 'anticon-profile');
export const QuestionCircleOutlined = /*#__PURE__*/ createIcon(HelpCircle, 'anticon-question-circle');
export const QuoteOutlined = /*#__PURE__*/ createIcon(TextQuote, 'anticon-quote');
export const RenameOutlined = /*#__PURE__*/ createIcon(TextCursorInput, 'anticon-rename');
export const ReceiptOutlined = /*#__PURE__*/ createIcon(ReceiptText, 'anticon-receipt');
export const ReloadOutlined = /*#__PURE__*/ createIcon(RotateCw, 'anticon-reload');
export const RightOutlined = /*#__PURE__*/ createIcon(ChevronRight, 'anticon-right');
export const RobotOutlined = /*#__PURE__*/ createIcon(Bot, 'anticon-robot');
export const RocketOutlined = /*#__PURE__*/ createIcon(Rocket, 'anticon-rocket');
export const RollbackOutlined = /*#__PURE__*/ createIcon(RotateCcw, 'anticon-rollback');
export const SafetyCertificateOutlined = /*#__PURE__*/ createIcon(ShieldCheck, 'anticon-safety-certificate');
export const SaveOutlined = /*#__PURE__*/ createIcon(Save, 'anticon-save');
export const SearchOutlined = /*#__PURE__*/ createIcon(Search, 'anticon-search');
export const SettingOutlined = /*#__PURE__*/ createIcon(Settings, 'anticon-setting');
export const ShopOutlined = /*#__PURE__*/ createIcon(Store, 'anticon-shop');
export const SlidersOutlined = /*#__PURE__*/ createIcon(SlidersHorizontal, 'anticon-sliders');
// The no-entry sign antd's own StopOutlined draws: an off or disabled state is a refusal, not the
// bare square a media player's stop key uses.
export const StopOutlined = /*#__PURE__*/ createIcon(Ban, 'anticon-stop');
export const SunOutlined = /*#__PURE__*/ createIcon(Sun, 'anticon-sun');
export const TimerResetOutlined = /*#__PURE__*/ createIcon(TimerReset, 'anticon-timer-reset');
export const UpgradeOutlined = /*#__PURE__*/ createIcon(CircleArrowUp, 'anticon-upgrade');
export const SyncOutlined = /*#__PURE__*/ createIcon(RefreshCw, 'anticon-sync');
export const TableOutlined = /*#__PURE__*/ createIcon(Table2, 'anticon-table');
export const TagOutlined = /*#__PURE__*/ createIcon(Tag, 'anticon-tag');
export const ThunderboltFilled = /*#__PURE__*/ createIcon(Zap, 'anticon-thunderbolt');
export const ThunderboltOutlined = /*#__PURE__*/ createIcon(Zap, 'anticon-thunderbolt');
export const UndoOutlined = /*#__PURE__*/ createIcon(Undo2, 'anticon-undo');
export const SwapOutlined = /*#__PURE__*/ createIcon(ArrowLeftRight, 'anticon-swap');
export const UpOutlined = /*#__PURE__*/ createIcon(ChevronUp, 'anticon-up');
export const UploadOutlined = /*#__PURE__*/ createIcon(Upload, 'anticon-upload');
export const VerticalAlignTopOutlined = /*#__PURE__*/ createIcon(ArrowUpToLine, 'anticon-vertical-align-top');
export const WarningOutlined = /*#__PURE__*/ createIcon(AlertTriangle, 'anticon-warning');

/**
 * The GitHub mark, drawn from Octicons' `mark-github` (MIT). Lucide no longer ships
 * brand marks, and a plugin's repository link is recognised by this glyph.
 */
export const GithubOutlined = /*#__PURE__*/ React.forwardRef<SVGSVGElement, AntdIconProps>(function GithubOutlinedIcon({ className, style, size = '1em' }, ref) {
  return (
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
  );
});
