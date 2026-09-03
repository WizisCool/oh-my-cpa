import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const WEB_SRC = path.join(ROOT, 'web', 'src');
const OUTPUT_DIR = path.join(ROOT, 'web', 'src', 'assets', 'fonts');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 1. Gather all unique characters from the project
const chars = new Set();

// Full ASCII printable
for (let i = 32; i <= 126; i++) {
  chars.add(String.fromCharCode(i));
}

// Common CJK punctuation and symbols
const symbols = [
  '›', '‹', '—', '·', '…', '‘', '’', '“', '”', '、', '。', '，', '！', '？', '：', '；',
  '《', '》', '〈', '〉', '【', '】', '（', '）', '「', '」', '『', '』', '〔', '〕',
  '¥', '€', '£', '₽', '№', '§', '✓', '✗', '▲', '▼', '◄', '►', '↑', '↓', '←', '→',
  'Ω', 'μ', 'π', '±', '≠', '≤', '≥', '÷', '×', '°', '·', '•', '～', '～', '※'
];
symbols.forEach((s) => chars.add(s));

// Scan web/src and web/index.html
function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath);
    } else if (/\.(tsx?|jsx?|css|html|json)$/.test(entry.name)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const char of content) {
        if (char >= ' ' || char === '\t') {
          chars.add(char);
        }
      }
    }
  }
}

scanDir(WEB_SRC);
const indexHtmlPath = path.join(ROOT, 'web', 'index.html');
if (fs.existsSync(indexHtmlPath)) {
  const content = fs.readFileSync(indexHtmlPath, 'utf8');
  for (const char of content) {
    if (char >= ' ' || char === '\t') chars.add(char);
  }
}

// Common operational & dev words (ensure full UI vocabulary coverage even if added later)
const commonDevVocab = [
  '增删改查创建更新删除保存取消确认编辑配置设置首选项',
  '成功失败警告错误正常异常健康离线在线连接断开重试',
  '高频低频流式并发吞吐延迟毫秒秒分时天日月年季度',
  '仪表盘观测网关控制运行系统实例端点凭证模型提供商',
  '密钥授权认证文件上传下载导出导入同步刷新整理未认领',
  '配额策略路由重试缓存标签状态过滤搜索全部未命名默认',
  '简体中文英文主题暗色浅色跟随系统布局导航面包屑',
  '只读管理超级管理员会话过期登录登出退出安全防护',
  '数据统计字节千字节兆字节吉字节进度条骨架屏',
  '纯粹终端扁平化等宽字体排版单行双栏多栏列表卡片',
  '代理协议适配转换转发上游下游请求响应状态码耗时',
  '深度测试诊断自检能力检查更新最新版本发布说明详情',
].join('');
for (const char of commonDevVocab) {
  chars.add(char);
}

// Write chars to tmp file
const tmpDir = path.join(ROOT, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
const charsFile = path.join(tmpDir, 'subset_chars.txt');
fs.writeFileSync(charsFile, Array.from(chars).sort().join(''), 'utf8');

console.log(`[font-subset] Collected ${chars.size} unique characters.`);

// Locate fonts
const candidates = [
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts'),
  'C:\\Windows\\Fonts',
];

function findFont(filenamePattern) {
  for (const dir of candidates) {
    if (!dir || !fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    const match = files.find((f) => filenamePattern.test(f));
    if (match) return path.join(dir, match);
  }
  return null;
}

const regularFont = findFont(/sarasa-mono-sc-(regular|nerd-font).*?\.ttf$/i);
const boldFont = findFont(/sarasa-mono-sc-(bold-nerd-font|bold).*?\.ttf$/i);

if (!regularFont) {
  console.error('[font-subset] Error: Sarasa Mono SC Regular font not found.');
  process.exit(1);
}

console.log(`[font-subset] Found Regular font: ${regularFont}`);

const regularOut = path.join(OUTPUT_DIR, 'sarasa-mono-sc-regular.woff2');
execSync(`pyftsubset "${regularFont}" --text-file="${charsFile}" --output-file="${regularOut}" --flavor=woff2 --layout-features=* --no-hinting --desubroutinize`, {
  stdio: 'inherit',
});

const regStat = fs.statSync(regularOut);
console.log(`[font-subset] Generated Regular subset: ${(regStat.size / 1024).toFixed(1)} KB`);

if (boldFont) {
  console.log(`[font-subset] Found Bold font: ${boldFont}`);
  const boldOut = path.join(OUTPUT_DIR, 'sarasa-mono-sc-bold.woff2');
  execSync(`pyftsubset "${boldFont}" --text-file="${charsFile}" --output-file="${boldOut}" --flavor=woff2 --layout-features=* --no-hinting --desubroutinize`, {
    stdio: 'inherit',
  });
  const boldStat = fs.statSync(boldOut);
  console.log(`[font-subset] Generated Bold subset: ${(boldStat.size / 1024).toFixed(1)} KB`);
}

console.log('[font-subset] Done!');
