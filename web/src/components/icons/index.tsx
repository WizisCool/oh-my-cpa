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
  BookOpen,
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

export interface IconProps extends Omit<LucideProps, 'ref'> {
  spin?: boolean;
  rotate?: number;
}

export /*#__PURE__*/ function createIcon(LucideComponent: LucideIcon, defaultClassName?: string) {
  return React.forwardRef<SVGSVGElement, IconProps>(function OmcIcon(props, ref) {
    const { spin, rotate, className, style, size = '1em', ...rest } = props;
    const combinedClassName = [
      'omc-icon',
      defaultClassName,
      spin ? 'omc-icon-spin' : '',
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

const SpinningLoader = /*#__PURE__*/ createIcon(LoaderCircle, 'omc-icon-loading');

export const ApiOutlined = /*#__PURE__*/ createIcon(Plug, 'omc-icon-api');
export const AppstoreOutlined = /*#__PURE__*/ createIcon(LayoutGrid, 'omc-icon-appstore');
export const ArrowDownOutlined = /*#__PURE__*/ createIcon(ArrowDown, 'omc-icon-arrow-down');
export const ArrowLeftOutlined = /*#__PURE__*/ createIcon(ArrowLeft, 'omc-icon-arrow-left');
export const ArrowRightOutlined = /*#__PURE__*/ createIcon(ArrowRight, 'omc-icon-arrow-right');
export const ArrowUpOutlined = /*#__PURE__*/ createIcon(ArrowUp, 'omc-icon-arrow-up');
export const AuditOutlined = /*#__PURE__*/ createIcon(ScrollText, 'omc-icon-audit');
export const BarChartOutlined = /*#__PURE__*/ createIcon(BarChart3, 'omc-icon-bar-chart');
export const BookOpenOutlined = /*#__PURE__*/ createIcon(BookOpen, 'omc-icon-book-open');
export const BlockOutlined = /*#__PURE__*/ createIcon(Boxes, 'omc-icon-block');
export const BoxOutlined = /*#__PURE__*/ createIcon(Box, 'omc-icon-box');
export const BranchesOutlined = /*#__PURE__*/ createIcon(GitBranch, 'omc-icon-branches');
export const BugOutlined = /*#__PURE__*/ createIcon(Bug, 'omc-icon-bug');
export const BulbOutlined = /*#__PURE__*/ createIcon(Lightbulb, 'omc-icon-bulb');
export const CaretDownOutlined = /*#__PURE__*/ createIcon(ChevronDown, 'omc-icon-caret-down');
export const CheckCircleOutlined = /*#__PURE__*/ createIcon(CheckCircle2, 'omc-icon-check-circle');
export const CheckOutlined = /*#__PURE__*/ createIcon(Check, 'omc-icon-check');
export const CheckSquareOutlined = /*#__PURE__*/ createIcon(ListChecks, 'omc-icon-check-square');
export const ClearOutlined = /*#__PURE__*/ createIcon(Eraser, 'omc-icon-clear');
export const ClockCircleOutlined = /*#__PURE__*/ createIcon(Clock, 'omc-icon-clock-circle');
export const CloseCircleOutlined = /*#__PURE__*/ createIcon(XCircle, 'omc-icon-close-circle');
export const CloseOutlined = /*#__PURE__*/ createIcon(X, 'omc-icon-close');
export const BellOutlined = /*#__PURE__*/ createIcon(Bell, 'omc-icon-bell');
export const BellOffOutlined = /*#__PURE__*/ createIcon(BellOff, 'omc-icon-bell-off');
export const CloudDownloadOutlined = /*#__PURE__*/ createIcon(CloudDownload, 'omc-icon-cloud-download');
export const CloudServerOutlined = /*#__PURE__*/ createIcon(Server, 'omc-icon-cloud-server');
export const CloudOutlined = /*#__PURE__*/ createIcon(Cloud, 'omc-icon-cloud');
export const CodeOutlined = /*#__PURE__*/ createIcon(Code, 'omc-icon-code');
export const CodeSandboxOutlined = /*#__PURE__*/ createIcon(SquareTerminal, 'omc-icon-code-sandbox');
export const CompassOutlined = /*#__PURE__*/ createIcon(Compass, 'omc-icon-compass');
export const CloudUploadOutlined = /*#__PURE__*/ createIcon(CloudUpload, 'omc-icon-cloud-upload');
export const CompressOutlined = /*#__PURE__*/ createIcon(Minimize2, 'omc-icon-compress');
export const ControlOutlined = /*#__PURE__*/ createIcon(Sliders, 'omc-icon-control');
export const CopyOutlined = /*#__PURE__*/ createIcon(Copy, 'omc-icon-copy');
export const DashboardOutlined = /*#__PURE__*/ createIcon(LayoutDashboard, 'omc-icon-dashboard');
export const DatabaseOutlined = /*#__PURE__*/ createIcon(Database, 'omc-icon-database');
export const DeleteOutlined = /*#__PURE__*/ createIcon(Trash2, 'omc-icon-delete');
export const DesktopOutlined = /*#__PURE__*/ createIcon(Monitor, 'omc-icon-desktop');
export const DollarOutlined = /*#__PURE__*/ createIcon(DollarSign, 'omc-icon-dollar');
export const DownOutlined = /*#__PURE__*/ createIcon(ChevronDown, 'omc-icon-down');
export const DownloadOutlined = /*#__PURE__*/ createIcon(Download, 'omc-icon-download');
export const EditOutlined = /*#__PURE__*/ createIcon(Pencil, 'omc-icon-edit');
export const ExclamationCircleOutlined = /*#__PURE__*/ createIcon(AlertCircle, 'omc-icon-exclamation-circle');
export const ExternalLinkOutlined = /*#__PURE__*/ createIcon(ExternalLink, 'omc-icon-external-link');
export const ExperimentOutlined = /*#__PURE__*/ createIcon(FlaskConical, 'omc-icon-experiment');
export const EyeInvisibleOutlined = /*#__PURE__*/ createIcon(EyeOff, 'omc-icon-eye-invisible');
export const EyeOutlined = /*#__PURE__*/ createIcon(Eye, 'omc-icon-eye');
export const FieldTimeOutlined = /*#__PURE__*/ createIcon(Timer, 'omc-icon-field-time');
export const FileTextOutlined = /*#__PURE__*/ createIcon(FileText, 'omc-icon-file-text');
export const FilterOutlined = /*#__PURE__*/ createIcon(Filter, 'omc-icon-filter');
export const FireOutlined = /*#__PURE__*/ createIcon(Flame, 'omc-icon-fire');
export const FormatPainterOutlined = /*#__PURE__*/ createIcon(Paintbrush, 'omc-icon-format-painter');
export const FullscreenExitOutlined = /*#__PURE__*/ createIcon(Minimize, 'omc-icon-fullscreen-exit');
export const FullscreenOutlined = /*#__PURE__*/ createIcon(Maximize, 'omc-icon-fullscreen');
export const ToolOutlined = /*#__PURE__*/ createIcon(Wrench, 'omc-icon-tool');
export const WrapTextOutlined = /*#__PURE__*/ createIcon(WrapText, 'omc-icon-wrap-text');
export const GlobalOutlined = /*#__PURE__*/ createIcon(Globe, 'omc-icon-global');
export const HistoryOutlined = /*#__PURE__*/ createIcon(History, 'omc-icon-history');
export const HourglassOutlined = /*#__PURE__*/ createIcon(Hourglass, 'omc-icon-hourglass');
export const HolderOutlined = /*#__PURE__*/ createIcon(GripVertical, 'omc-icon-holder');
export const InsightsOutlined = /*#__PURE__*/ createIcon(ChartNoAxesCombined, 'omc-icon-insights');
export const InfoCircleOutlined = /*#__PURE__*/ createIcon(Info, 'omc-icon-info-circle');
export const KeyOutlined = /*#__PURE__*/ createIcon(Key, 'omc-icon-key');
export const LayersOutlined = /*#__PURE__*/ createIcon(Layers, 'omc-icon-layers');
export const LayoutOutlined = /*#__PURE__*/ createIcon(PanelRight, 'omc-icon-layout');
export const LeftOutlined = /*#__PURE__*/ createIcon(ChevronLeft, 'omc-icon-left');
export const LineChartOutlined = /*#__PURE__*/ createIcon(ChartLine, 'omc-icon-line-chart');
export const ListOutlined = /*#__PURE__*/ createIcon(List, 'omc-icon-list');
export const LinkOutlined = /*#__PURE__*/ createIcon(Link, 'omc-icon-link');
export const LoadingOutlined = (props: IconProps) => <SpinningLoader spin {...props} />;
export const LockOutlined = /*#__PURE__*/ createIcon(Lock, 'omc-icon-lock');
export const LoginOutlined = /*#__PURE__*/ createIcon(LogIn, 'omc-icon-login');
export const LogoutOutlined = /*#__PURE__*/ createIcon(LogOut, 'omc-icon-logout');
export const MenuFoldOutlined = /*#__PURE__*/ createIcon(PanelLeftClose, 'omc-icon-menu-fold');
export const MenuUnfoldOutlined = /*#__PURE__*/ createIcon(PanelLeftOpen, 'omc-icon-menu-unfold');
export const MessageOutlined = /*#__PURE__*/ createIcon(MessageSquarePlus, 'omc-icon-message');
export const StepsOutlined = /*#__PURE__*/ createIcon(ListTree, 'omc-icon-steps');
export const MoonOutlined = /*#__PURE__*/ createIcon(Moon, 'omc-icon-moon');
// A request answered in one payload. A struck broadcast mark, because the stream is what is absent;
// the boxes glyph belongs to Model Square.
export const NonStreamOutlined = /*#__PURE__*/ createIcon(RadioOff, 'omc-icon-non-stream');
// A request carried over an upstream WebSocket: a held connection, so a cable rather than a broadcast.
export const WebsocketOutlined = /*#__PURE__*/ createIcon(Cable, 'omc-icon-websocket');
export const MoreOutlined = /*#__PURE__*/ createIcon(MoreHorizontal, 'omc-icon-more');
export const NodeIndexOutlined = /*#__PURE__*/ createIcon(Network, 'omc-icon-node-index');
export const PauseCircleOutlined = /*#__PURE__*/ createIcon(PauseCircle, 'omc-icon-pause-circle');
export const PaperClipOutlined = /*#__PURE__*/ createIcon(Paperclip, 'omc-icon-paper-clip');
export const PictureOutlined = /*#__PURE__*/ createIcon(Image, 'omc-icon-picture');
export const NoteOutlined = /*#__PURE__*/ createIcon(StickyNote, 'omc-icon-note');
export const PackageSearchOutlined = /*#__PURE__*/ createIcon(PackageSearch, 'omc-icon-package-search');
export const PuzzleOutlined = /*#__PURE__*/ createIcon(Puzzle, 'omc-icon-puzzle');
export const PlayCircleOutlined = /*#__PURE__*/ createIcon(PlayCircle, 'omc-icon-play-circle');
export const PlusOutlined = /*#__PURE__*/ createIcon(Plus, 'omc-icon-plus');
export const ProfileOutlined = /*#__PURE__*/ createIcon(FileText, 'omc-icon-profile');
export const QuestionCircleOutlined = /*#__PURE__*/ createIcon(HelpCircle, 'omc-icon-question-circle');
export const QuoteOutlined = /*#__PURE__*/ createIcon(TextQuote, 'omc-icon-quote');
export const RenameOutlined = /*#__PURE__*/ createIcon(TextCursorInput, 'omc-icon-rename');
export const ReceiptOutlined = /*#__PURE__*/ createIcon(ReceiptText, 'omc-icon-receipt');
export const ReloadOutlined = /*#__PURE__*/ createIcon(RotateCw, 'omc-icon-reload');
export const RightOutlined = /*#__PURE__*/ createIcon(ChevronRight, 'omc-icon-right');
export const RobotOutlined = /*#__PURE__*/ createIcon(Bot, 'omc-icon-robot');
export const RocketOutlined = /*#__PURE__*/ createIcon(Rocket, 'omc-icon-rocket');
export const RollbackOutlined = /*#__PURE__*/ createIcon(RotateCcw, 'omc-icon-rollback');
export const SafetyCertificateOutlined = /*#__PURE__*/ createIcon(ShieldCheck, 'omc-icon-safety-certificate');
export const SaveOutlined = /*#__PURE__*/ createIcon(Save, 'omc-icon-save');
export const SearchOutlined = /*#__PURE__*/ createIcon(Search, 'omc-icon-search');
export const SettingOutlined = /*#__PURE__*/ createIcon(Settings, 'omc-icon-setting');
export const ShopOutlined = /*#__PURE__*/ createIcon(Store, 'omc-icon-shop');
export const SlidersOutlined = /*#__PURE__*/ createIcon(SlidersHorizontal, 'omc-icon-sliders');
// The no-entry sign antd's own StopOutlined draws: an off or disabled state is a refusal, not the
// bare square a media player's stop key uses.
export const StopOutlined = /*#__PURE__*/ createIcon(Ban, 'omc-icon-stop');
export const SunOutlined = /*#__PURE__*/ createIcon(Sun, 'omc-icon-sun');
export const TimerResetOutlined = /*#__PURE__*/ createIcon(TimerReset, 'omc-icon-timer-reset');
export const UpgradeOutlined = /*#__PURE__*/ createIcon(CircleArrowUp, 'omc-icon-upgrade');
export const SyncOutlined = /*#__PURE__*/ createIcon(RefreshCw, 'omc-icon-sync');
export const TableOutlined = /*#__PURE__*/ createIcon(Table2, 'omc-icon-table');
export const TagOutlined = /*#__PURE__*/ createIcon(Tag, 'omc-icon-tag');
export const ThunderboltFilled = /*#__PURE__*/ createIcon(Zap, 'omc-icon-thunderbolt');
export const ThunderboltOutlined = /*#__PURE__*/ createIcon(Zap, 'omc-icon-thunderbolt');
export const UndoOutlined = /*#__PURE__*/ createIcon(Undo2, 'omc-icon-undo');
export const SwapOutlined = /*#__PURE__*/ createIcon(ArrowLeftRight, 'omc-icon-swap');
export const UpOutlined = /*#__PURE__*/ createIcon(ChevronUp, 'omc-icon-up');
export const UploadOutlined = /*#__PURE__*/ createIcon(Upload, 'omc-icon-upload');
export const VerticalAlignTopOutlined = /*#__PURE__*/ createIcon(ArrowUpToLine, 'omc-icon-vertical-align-top');
export const WarningOutlined = /*#__PURE__*/ createIcon(AlertTriangle, 'omc-icon-warning');

/**
 * The GitHub mark, drawn from Octicons' `mark-github` (MIT). Lucide no longer ships
 * brand marks, and a plugin's repository link is recognised by this glyph.
 */
export const GithubOutlined = /*#__PURE__*/ React.forwardRef<SVGSVGElement, IconProps>(function GithubOutlinedIcon({ className, style, size = '1em' }, ref) {
  return (
    <svg
      ref={ref}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className={['omc-icon', 'omc-icon-github', className].filter(Boolean).join(' ')}
      style={style}
    >
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
});
