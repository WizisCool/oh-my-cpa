import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_URL, SITE_ORIGIN } from '../deploy/site/site-meta.mjs';

const GITHUB_WEB = GITHUB_URL;
export { SITE_ORIGIN };
export const DOCS_LANGUAGES = ['en', 'zh'];

function readBranch() {
  const ref = process.env.GITHUB_REF_NAME?.trim();
  return ref || 'main';
}

/** Console assets the public site reuses: `[repository source, published file name]`. */
export const BRAND_ASSETS = [
  ['web/src/assets/brand/omc-wordmark-light.svg', 'wordmark-light.svg'],
  ['web/src/assets/brand/omc-wordmark-dark.svg', 'wordmark-dark.svg'],
  ['web/public/favicon.svg', 'mark.svg'],
];

const ZH_ENGLISH_ONLY = '本页当前以仓库英文原文发布。';

/**
 * The documentation site's navigation, from simple to advanced. Each section is a sidebar
 * group; each page names its canonical repository source per language. Pages without a
 * Chinese translation reuse the English source and carry `zhNotice`.
 */
export const DOCS_SECTIONS = [
  {
    dir: 'start',
    title: { en: 'Get started', zh: '开始使用' },
    description: { en: 'First deployment, agent-assisted install and how the pieces fit.', zh: '首次部署、让 Agent 代装，以及各部分如何协作。' },
    icon: 'Rocket',
    pages: [
      {
        slug: 'quickstart',
        source: { en: 'docs/quickstart.md', zh: 'docs/zh/quickstart.md' },
        title: { en: 'Quickstart', zh: '快速开始' },
        description: {
          en: 'Run the gateway, Oh My CPA and the updater with Docker Compose in about three minutes.',
          zh: '用 Docker Compose 约三分钟跑起网关、Oh My CPA 与更新器。',
        },
      },
      {
        slug: 'agent',
        source: { en: 'docs/install-for-agents.md', zh: 'docs/zh/install-for-agents.md' },
        title: { en: 'Install with an agent', zh: '让 Agent 安装' },
        description: {
          en: 'Paste one prompt into Claude Code, Codex or Cursor and let it install Oh My CPA safely.',
          zh: '把一句提示词交给 Claude Code、Codex 或 Cursor，让它安全地完成安装。',
        },
      },
      {
        slug: 'how-it-works',
        source: { en: 'docs/how-it-works.md', zh: 'docs/zh/how-it-works.md' },
        title: { en: 'How it works', zh: '工作原理' },
        description: {
          en: 'How Oh My CPA sits beside CLIProxyAPI, which keys it needs and where data lives.',
          zh: 'Oh My CPA 如何与 CLIProxyAPI 协作、需要哪些密钥、数据存在哪里。',
        },
      },
    ],
  },
  {
    dir: 'install',
    title: { en: 'Install', zh: '安装' },
    description: { en: 'Every install path, remote access, upgrades and troubleshooting.', zh: '全部安装方式、远程访问、升级与排障。' },
    icon: 'Download',
    index: {
      source: { en: 'docs/install.md', zh: 'docs/zh/install.md' },
      title: { en: 'Choose an install path', zh: '选择安装方式' },
      description: {
        en: 'Pick the installation that matches where your gateway runs today.',
        zh: '按网关当前的运行位置选择安装方式。',
      },
    },
    pages: [
      {
        slug: 'standalone',
        source: { en: 'docs/install/standalone.md', zh: 'docs/zh/install/standalone.md' },
        title: { en: 'Standalone', zh: '独立部署' },
        description: {
          en: 'Add Oh My CPA beside a running gateway and leave the gateway as it is.',
          zh: '在已运行的网关旁加装 Oh My CPA，网关保持原样。',
        },
      },
      {
        slug: 'compose',
        source: { en: 'docs/install/compose.md', zh: 'docs/zh/install/compose.md' },
        title: { en: 'Existing Compose file', zh: '并入现有编排' },
        description: {
          en: 'Add Oh My CPA and its updater to the Compose file that already runs the gateway.',
          zh: '把 Oh My CPA 与更新器加入已运行网关的 Compose 文件。',
        },
      },
      {
        slug: 'native',
        source: { en: 'docs/install/native.md', zh: 'docs/zh/install/native.md' },
        title: { en: 'Native executable', zh: '原生可执行文件' },
        description: {
          en: 'Run the single executable on macOS, Windows, Linux or FreeBSD without Docker.',
          zh: '不用 Docker，在 macOS、Windows、Linux 或 FreeBSD 上运行单个可执行文件。',
        },
      },
      {
        slug: 'source',
        source: { en: 'docs/install/source.md', zh: 'docs/zh/install/source.md' },
        title: { en: 'Build from source', zh: '从源码构建' },
        description: {
          en: 'Build the console and server from a checkout with Go, Node.js and pnpm.',
          zh: '用 Go、Node.js 与 pnpm 从源码构建控制台与服务端。',
        },
      },
      {
        slug: 'remote-access',
        source: { en: 'docs/install/remote-access.md', zh: 'docs/zh/install/remote-access.md' },
        title: { en: 'Remote access and HTTPS', zh: '远程访问与 HTTPS' },
        description: {
          en: 'Reach the console over an SSH tunnel or a reverse proxy, and install it as an app.',
          zh: '通过 SSH 隧道或反向代理访问控制台，并将其安装为应用。',
        },
      },
      {
        slug: 'upgrade',
        source: { en: 'docs/install/upgrade.md', zh: 'docs/zh/install/upgrade.md' },
        title: { en: 'Upgrading', zh: '升级' },
        description: {
          en: 'Update from the console in one click, by hand, or add the updater to an older install.',
          zh: '在控制台一键更新、手动更新，或为旧部署加装更新器。',
        },
      },
      {
        slug: 'troubleshooting',
        source: { en: 'docs/install/troubleshooting.md', zh: 'docs/zh/install/troubleshooting.md' },
        title: { en: 'Troubleshooting', zh: '排障' },
        description: {
          en: 'Check health and fix port, permission, connection and sign-in problems.',
          zh: '检查健康状态，解决端口、权限、连接与登录问题。',
        },
      },
    ],
  },
  {
    dir: 'operate',
    title: { en: 'Operate', zh: '运维' },
    description: { en: 'Ports, storage, updates, backups, keys and time zone.', zh: '端口、存储、更新、备份、密钥与时区。' },
    icon: 'Server',
    index: {
      source: { en: 'docs/operations.md', zh: 'docs/zh/operations.md' },
      title: { en: 'Operations', zh: '运维概览' },
      description: {
        en: 'Day-to-day tasks for a running console and the rules a deployment must keep.',
        zh: '运行中控制台的日常任务，以及部署必须遵守的约束。',
      },
    },
    pages: [
      {
        slug: 'ports-storage',
        source: { en: 'docs/operate/ports-storage.md', zh: 'docs/zh/operate/ports-storage.md' },
        title: { en: 'Ports and storage', zh: '端口与存储' },
        description: {
          en: 'Change the listening port and keep the database in a volume or a host directory.',
          zh: '修改监听端口，把数据库放在命名卷或宿主机目录。',
        },
      },
      {
        slug: 'updates',
        source: { en: 'docs/operate/updates.md', zh: 'docs/zh/operate/updates.md' },
        title: { en: 'Updates', zh: '更新' },
        description: {
          en: 'How release checks work and how the signed, isolated updater replaces containers.',
          zh: '版本检查如何工作，以及签名校验、隔离运行的更新器如何替换容器。',
        },
      },
      {
        slug: 'backup',
        source: { en: 'docs/ops/sqlite-operations.md', zh: 'docs/zh/ops/sqlite-operations.md' },
        title: { en: 'Backup and restore', zh: '备份与恢复' },
        description: {
          en: 'Encrypted backups, cloud recovery, master key governance and database maintenance.',
          zh: '加密备份、云端恢复、主密钥治理与数据库维护。',
        },
      },
      {
        slug: 'keys',
        source: { en: 'docs/operate/keys.md', zh: 'docs/zh/operate/keys.md' },
        title: { en: 'Keys', zh: '密钥' },
        description: {
          en: 'Keep the master key safe and rotate the CPA management key.',
          zh: '妥善保管主密钥，并轮换 CPA 管理密钥。',
        },
      },
      {
        slug: 'time-zone',
        source: { en: 'docs/operate/time-zone.md', zh: 'docs/zh/operate/time-zone.md' },
        title: { en: 'Time zone', zh: '时区' },
        description: {
          en: 'Choose the calendar that daily statistics and timestamps follow.',
          zh: '选择每日统计与时间显示所用的日历。',
        },
      },
    ],
  },
  {
    dir: 'features',
    title: { en: 'Features', zh: '功能' },
    description: { en: 'Agent and MCP, routing, quota, pricing, playground and plugins.', zh: 'Agent 与 MCP、路由、配额、定价、试验场与插件。' },
    icon: 'Sparkles',
    pages: [
      {
        slug: 'agent',
        source: { en: 'docs/features/agent.md', zh: 'docs/zh/features/agent.md' },
        title: { en: 'Agent and MCP', zh: 'Agent 与 MCP' },
        description: {
          en: 'Operate the console in conversation and connect external agents over MCP.',
          zh: '以对话方式操作控制台，并通过 MCP 接入外部 Agent。',
        },
      },
      {
        slug: 'routing',
        source: { en: 'docs/features/routing.md', zh: 'docs/zh/features/routing.md' },
        title: { en: 'Routing and model rules', zh: '路由与模型规则' },
        description: {
          en: 'Arrange providers and OAuth credentials into priority tiers and edit model rules.',
          zh: '把提供商与 OAuth 凭据编排为优先级，并编辑模型规则。',
        },
      },
      {
        slug: 'quota',
        source: { en: 'docs/features/quota.md', zh: 'docs/zh/features/quota.md' },
        title: { en: 'Quota and warmup', zh: '配额与预热' },
        description: {
          en: 'Observe quota windows and cooldowns, and start windows on a schedule.',
          zh: '观测配额窗口与冷却，并按计划预热窗口。',
        },
      },
      {
        slug: 'pricing',
        source: { en: 'docs/pricing.md', zh: 'docs/zh/pricing.md' },
        title: { en: 'Pricing and cost', zh: '定价与费用' },
        description: {
          en: 'How each request is priced, which rates apply and how cost evidence is kept.',
          zh: '每个请求如何计价、适用哪些费率，以及费用证据如何保存。',
        },
      },
      {
        slug: 'playground',
        source: { en: 'docs/features/playground.md', zh: 'docs/zh/features/playground.md' },
        title: { en: 'Playground and models', zh: '操练场与模型' },
        description: {
          en: 'Try a model with a real client key and browse the live model directory.',
          zh: '用真实客户端密钥试用模型，浏览实时模型目录。',
        },
      },
      {
        slug: 'plugins',
        source: { en: 'docs/features/plugins.md', zh: 'docs/zh/features/plugins.md' },
        title: { en: 'Plugins', zh: '插件' },
        description: {
          en: 'Install plugins from the store and open their pages inside the console.',
          zh: '从商店安装插件，并在控制台内打开插件页面。',
        },
      },
      {
        slug: 'display',
        source: { en: 'docs/features/display.md', zh: 'docs/zh/features/display.md' },
        title: { en: 'Display and icons', zh: '展示与图标' },
        description: {
          en: 'Display currency, TPS calculation and custom provider icons.',
          zh: '展示币种、TPS 口径与自定义提供商图标。',
        },
      },
    ],
  },
  {
    dir: 'reference',
    title: { en: 'Reference', zh: '参考' },
    description: { en: 'Environment variables, the CPA contract, glossary and API.', zh: '环境变量、CPA 契约、术语表与 API。' },
    icon: 'BookMarked',
    pages: [
      {
        slug: 'environment',
        source: { en: 'docs/reference/environment.md', zh: 'docs/zh/reference/environment.md' },
        title: { en: 'Environment variables', zh: '环境变量' },
        description: {
          en: 'Every setting Oh My CPA, its Compose files and its updater read.',
          zh: 'Oh My CPA、Compose 模板与更新器读取的全部配置项。',
        },
      },
      {
        slug: 'cpa-contract',
        source: { en: 'docs/cpa-v8-compat.md', zh: 'docs/zh/cpa-v8-compat.md' },
        title: { en: 'CPA contract', zh: 'CPA 契约' },
        description: {
          en: 'What Oh My CPA reads from and writes to the CLIProxyAPI v8 Management API.',
          zh: 'Oh My CPA 对 CLIProxyAPI v8 管理 API 的读写范围。',
        },
      },
      {
        slug: 'glossary',
        source: { en: 'CONTEXT.md', zh: 'CONTEXT.md' },
        title: { en: 'Glossary', zh: '术语表' },
        description: {
          en: 'Canonical terms for identity, usage, billing and automation.',
          zh: '身份、用量、计费与自动化相关的标准术语。',
        },
        zhNotice: ZH_ENGLISH_ONLY,
      },
    ],
    links: [
      { title: { en: 'API reference', zh: 'API 参考' }, url: '/api-reference/' },
      { title: { en: 'Release notes', zh: '版本发布' }, url: `${GITHUB_WEB}/releases` },
    ],
  },
  {
    dir: 'develop',
    title: { en: 'Develop', zh: '开发' },
    description: { en: 'Architecture, agent capabilities and contributing.', zh: '系统架构、Agent 能力与参与贡献。' },
    icon: 'Code',
    pages: [
      {
        slug: 'architecture',
        source: { en: 'docs/dev/architecture.md', zh: 'docs/dev/architecture.md' },
        title: { en: 'Architecture', zh: '系统架构' },
        description: {
          en: 'Module ownership, trust boundaries, write gates and frontend delivery.',
          zh: '模块职责、信任边界、写入门禁与前端交付。',
        },
        zhNotice: ZH_ENGLISH_ONLY,
      },
      {
        slug: 'capabilities',
        source: { en: 'docs/agent-capabilities.md', zh: 'docs/zh/agent-capabilities.md' },
        title: { en: 'Agent capabilities', zh: 'Agent 能力' },
        description: {
          en: 'The shared capability registry behind the Agent and MCP, and how to add an operation.',
          zh: 'Agent 与 MCP 共用的能力注册表，以及如何新增操作。',
        },
      },
      {
        slug: 'contributing',
        source: { en: 'CONTRIBUTING.md', zh: 'CONTRIBUTING.md' },
        title: { en: 'Contributing', zh: '参与贡献' },
        description: {
          en: 'Local development, verification and contribution workflow.',
          zh: '本地开发、验证与贡献流程。',
        },
        zhNotice: ZH_ENGLISH_ONLY,
      },
    ],
  },
];

export const DOCS_HOME = {
  title: { en: 'Documentation', zh: '文档' },
  description: {
    en: 'Install, operate and extend Oh My CPA, the self-hosted AI gateway console.',
    zh: '安装、运维与扩展 Oh My CPA：自托管的 AI 网关控制台。',
  },
};

/** Every content page with its section, in navigation order; section indexes come first. */
export function listDocsPages() {
  const pages = [];
  for (const section of DOCS_SECTIONS) {
    if (section.index) pages.push({ ...section.index, section: section.dir, slug: section.dir, isIndex: true });
    for (const page of section.pages) pages.push({ ...page, section: section.dir, slug: `${section.dir}/${page.slug}` });
  }
  return pages;
}

export function docsUrl(lang, slug = '') {
  return slug ? `/${lang}/${slug}/` : `/${lang}/`;
}

export function buildSourceLinkMap() {
  const map = new Map();
  for (const page of listDocsPages()) {
    const en = docsUrl('en', page.slug);
    const zh = docsUrl('zh', page.slug);
    if (page.source.en === page.source.zh) {
      map.set(page.source.en, { en, zh });
    } else {
      // A link written in either language's source to the other's file keeps that file's language.
      map.set(page.source.en, { en, zh: en });
      map.set(page.source.zh, { en: zh, zh });
    }
  }
  for (const readme of ['README.md', 'docs/README.md']) map.set(readme, { en: '/en/', zh: '/en/' });
  for (const readme of ['README.zh-CN.md', 'docs/zh/README.md']) map.set(readme, { en: '/zh/', zh: '/zh/' });
  return map;
}

function metaFiles() {
  const files = [];
  for (const lang of DOCS_LANGUAGES) {
    const suffix = lang === 'en' ? '' : `.${lang}`;
    files.push({
      file: `meta${suffix}.json`,
      data: { title: DOCS_HOME.title[lang], pages: ['index', ...DOCS_SECTIONS.map((section) => section.dir)] },
    });
    for (const [index, section] of DOCS_SECTIONS.entries()) {
      const links = (section.links ?? []).map((link) => `[${link.title[lang]}](${link.url})`);
      files.push({
        file: `${section.dir}/meta${suffix}.json`,
        data: {
          title: section.title[lang],
          description: section.description[lang],
          icon: section.icon,
          // Only the first-run section starts expanded; the sidebar opens the active page's folder itself.
          ...(index === 0 ? { defaultOpen: true } : {}),
          pages: [...(section.index ? ['index'] : []), ...section.pages.map((page) => page.slug), ...links],
        },
      });
    }
  }
  return files;
}

function rewriteMarkdownForMdx(markdown, {
  sourcePath,
  lang,
  repoRoot,
  sourceLinkMap,
  branch,
  zhNotice = '',
}) {
  let text = markdown.replace(/\r\n/g, '\n');
  text = text.replace(/^#\s+[^\n]+\n+/, '');
  text = text.replace(/<a\s+id="([^"]+)"\s*><\/a>/g, '<span id="$1" />');

  // Convert GitHub callouts (> [!TIP], > [!IMPORTANT], > [!NOTE], > [!WARNING]) into Fumadocs Callout blocks.
  text = text.replace(
    /(^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n(?:^>.*\n?)*)/gm,
    (block, _all, kind) => {
      const typeMap = {
        NOTE: 'info',
        TIP: 'info',
        IMPORTANT: 'warn',
        WARNING: 'warn',
        CAUTION: 'error',
      };
      const calloutType = typeMap[kind] ?? 'info';
      const innerLines = block
        .split('\n')
        .slice(1)
        .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''))
        .map((line) => line.replace(/^>\s?/, ''));
      return `<Callout type="${calloutType}">\n\n${innerLines.join('\n')}\n\n</Callout>\n`;
    },
  );

  // Protect fenced code blocks first (` ```...``` `) so single backticks inside code blocks
  // never split out of alignment.
  const fencedRegex = /```[\s\S]*?```/g;
  const fencedParts = [];
  let lastIndex = 0;
  for (const match of text.matchAll(fencedRegex)) {
    if (match.index > lastIndex) {
      fencedParts.push({ isCode: false, value: text.slice(lastIndex, match.index) });
    }
    fencedParts.push({ isCode: true, value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    fencedParts.push({ isCode: false, value: text.slice(lastIndex) });
  }

  const sourceDir = path.posix.dirname(sourcePath);

  const rewriteLinksInProse = (prose) => {
    const protectedChunks = [];
    const tokenRe = /!?\[(?:`[^`\n]+`|[^\]\n])*\]\([^)\s]+(?:\s+"[^"]*")?\)|`[^`\n]+`/g;
    let cursor = 0;
    for (const m of prose.matchAll(tokenRe)) {
      if (m.index > cursor) {
        protectedChunks.push({ type: 'text', value: prose.slice(cursor, m.index) });
      }
      const raw = m[0];
      if (raw.startsWith('`')) {
        protectedChunks.push({ type: 'code', value: raw });
      } else {
        protectedChunks.push({ type: 'link', value: raw });
      }
      cursor = m.index + raw.length;
    }
    if (cursor < prose.length) {
      protectedChunks.push({ type: 'text', value: prose.slice(cursor) });
    }
    return protectedChunks
      .map((chunk) => {
        if (chunk.type === 'code') return chunk.value;
        if (chunk.type === 'link') {
          return chunk.value.replace(/^(!?)\[((?:`[^`\n]+`|[^\]\n])*)\]\(([^)\s]+(?:\s+"[^"]*")?)\)$/, (full, bang, label, rawTarget) => {
            const target = rawTarget.split(/\s+"/)[0];
            if (/^(?:https?:|mailto:|#)/i.test(target)) {
              if (!bang && target.startsWith('https://omc-demo.junze.dev')) {
                return `[${label}](/demo/)`;
              }
              if (!bang && target.startsWith('https://omc.junze.dev/api-reference/')) {
                return `[${label}](/api-reference/)`;
              }
              if (!bang && target === 'https://omc.junze.dev/docs/') {
                return `[${label}](/en/)`;
              }
              if (!bang && target === 'https://omc.junze.dev/docs/zh/') {
                return `[${label}](/zh/)`;
              }
              return full;
            }
            const [rawPath, hash] = target.split('#');
            const resolved = path.posix.normalize(sourceDir === '.' ? rawPath : path.posix.join(sourceDir, rawPath));

            if (bang === '!') {
              if (resolved.startsWith('docs/images/readme/')) {
                return `![${label}](/docs/images/${path.posix.basename(resolved)})`;
              }
              return `![${label}](${GITHUB_WEB}/raw/${branch}/${resolved})`;
            }

            if (sourceLinkMap.has(resolved)) {
              const targetUrl = sourceLinkMap.get(resolved)[lang];
              const suffix = hash ? `#${hash}` : '';
              return `[${label}](${targetUrl}${suffix})`;
            }

            const absOnDisk = path.join(repoRoot, resolved);
            const isDir = fs.existsSync(absOnDisk) && fs.statSync(absOnDisk).isDirectory();
            const kind = isDir ? 'tree' : 'blob';
            const suffix = hash ? `#${hash}` : '';
            return `[${label}](${GITHUB_WEB}/${kind}/${branch}/${resolved}${suffix})`;
          });
        }
        let out = chunk.value;
        out = out.replace(/<br\s*\/?>/g, '<br />');
        out = out.replace(/<((?!\/?(?:Callout|span|div|figure|figcaption|img|strong|br)\b)(?!https?:\/\/)[^>\n]{1,80})>/g, '&lt;$1&gt;');
        out = out.replace(/(^|[^\\$])\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$1\\{$2\\}');
        return out;
      })
      .join('');
  };

  const rewritten = fencedParts
    .map((chunk) => {
      if (chunk.isCode) {
        return chunk.value.replace(/^```caddyfile\b/, '```text');
      }
      return rewriteLinksInProse(chunk.value);
    })
    .join('');

  const trimmed = rewritten.trim();
  const noticeBlock = zhNotice
    ? `<Callout type="info">\n\n${zhNotice}\n\n</Callout>\n\n`
    : '';
  return `${noticeBlock}${trimmed}\n`;
}

function formatFrontmatter({ title, description, source }) {
  const esc = (v) => JSON.stringify(String(v));
  const lines = ['---', `title: ${esc(title)}`, `description: ${esc(description)}`];
  if (source) lines.push(`source: ${esc(source)}`);
  return [...lines, '---', ''].join('\n');
}

/** Turns a page's MDX body into plain Markdown for agents: absolute links, no JSX wrappers. */
function toAgentMarkdown({ title, description, body }) {
  const withoutWrappers = body
    .replace(/<Callout type="[a-z]+">\n\n([\s\S]*?)\n\n<\/Callout>/g, (_m, inner) => inner.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n'))
    .replace(/<span id="[^"]+" \/>\n*/g, '')
    .replace(/\]\(\/(en|zh)\//g, `](${SITE_ORIGIN}/docs/$1/`)
    .replace(/\]\(\/(api-reference|demo)\//g, `](${SITE_ORIGIN}/$1/`)
    .replace(/\]\(\/docs\//g, `](${SITE_ORIGIN}/docs/`);
  // Unescape MDX-specific prose escapes outside fenced code blocks.
  const plain = withoutWrappers
    .split(/(```[\s\S]*?```)/g)
    .map((part, idx) =>
      idx % 2 === 1
        ? part
        : part
            .replace(/\\([{}])/g, '$1')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>'),
    )
    .join('');
  return `# ${title}\n\n> ${description}\n\n${plain.trim()}\n`;
}

function llmsIndex(lang, entries) {
  const home = DOCS_HOME;
  const lines = [`# Oh My CPA`, '', `> ${home.description[lang]}`, ''];
  for (const section of DOCS_SECTIONS) {
    lines.push(`## ${section.title[lang]}`, '');
    for (const entry of entries.filter((e) => e.section === section.dir)) {
      lines.push(`- [${entry.title}](${SITE_ORIGIN}/docs${docsUrl(lang, entry.slug).replace(/\/$/, '')}.md): ${entry.description}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

export async function syncDocsSite({ repoRoot }) {
  const docsAppDir = path.join(repoRoot, 'deploy', 'site', 'docs');
  const contentDir = path.join(docsAppDir, 'content', 'docs');
  const publicDir = path.join(docsAppDir, 'public');
  const publicImagesDir = path.join(publicDir, 'images');
  const readmeImagesDir = path.join(repoRoot, 'docs', 'images', 'readme');
  const branch = readBranch();
  const sourceLinkMap = buildSourceLinkMap();

  fs.rmSync(contentDir, { recursive: true, force: true });
  fs.mkdirSync(contentDir, { recursive: true });
  for (const lang of DOCS_LANGUAGES) fs.rmSync(path.join(publicDir, lang), { recursive: true, force: true });

  const write = (rel, text) => {
    const abs = path.join(contentDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  const writePublic = (rel, text) => {
    const abs = path.join(publicDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };

  // The home page is rendered by the docs app; its MDX entry only carries metadata.
  for (const lang of DOCS_LANGUAGES) {
    write(lang === 'en' ? 'index.mdx' : `index.${lang}.mdx`, formatFrontmatter({ title: DOCS_HOME.title[lang], description: DOCS_HOME.description[lang] }));
  }

  const pages = listDocsPages();
  for (const lang of DOCS_LANGUAGES) {
    const entries = [];
    for (const page of pages) {
      const sourceRel = page.source[lang];
      const sourceAbs = path.join(repoRoot, sourceRel);
      if (!fs.existsSync(sourceAbs)) {
        throw new Error(`Missing docs source file: ${sourceRel}`);
      }
      const body = rewriteMarkdownForMdx(fs.readFileSync(sourceAbs, 'utf8'), {
        sourcePath: sourceRel,
        lang,
        repoRoot,
        sourceLinkMap,
        branch,
        zhNotice: lang === 'zh' ? page.zhNotice ?? '' : '',
      });
      const title = page.title[lang];
      const description = page.description[lang];
      const suffix = lang === 'en' ? '' : `.${lang}`;
      const file = page.isIndex ? `${page.slug}/index${suffix}.mdx` : `${page.slug}${suffix}.mdx`;
      write(file, `${formatFrontmatter({ title, description, source: sourceRel })}\n${body}`);
      writePublic(`${lang}/${page.slug}.md`, toAgentMarkdown({ title, description, body }));
      entries.push({ section: page.section, slug: page.slug, title, description });
    }
    writePublic(lang === 'en' ? 'llms.txt' : `${lang}/llms.txt`, llmsIndex(lang, entries));
  }

  for (const meta of metaFiles()) {
    write(meta.file, `${JSON.stringify(meta.data, null, 2)}\n`);
  }

  // Copy README WebP screenshots into public/images so `/docs/images/*.webp` resolves offline.
  fs.rmSync(publicImagesDir, { recursive: true, force: true });
  if (fs.existsSync(readmeImagesDir)) {
    fs.mkdirSync(publicImagesDir, { recursive: true });
    for (const file of fs.readdirSync(readmeImagesDir)) {
      if (file.endsWith('.webp')) {
        fs.copyFileSync(path.join(readmeImagesDir, file), path.join(publicImagesDir, file));
      }
    }
  }

  // Brand artwork and the code typeface are copied from the console so the two never drift.
  const brandDir = path.join(publicDir, 'brand');
  fs.rmSync(brandDir, { recursive: true, force: true });
  fs.mkdirSync(brandDir, { recursive: true });
  for (const [from, to] of BRAND_ASSETS) fs.copyFileSync(path.join(repoRoot, from), path.join(brandDir, to));

  return {
    contentDir,
    pageCount: pages.length * DOCS_LANGUAGES.length,
  };
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(selfPath)) {
  const repoRoot = path.resolve(path.dirname(selfPath), '..');
  const result = await syncDocsSite({ repoRoot });
  console.log(`synced ${result.pageCount} bilingual MDX pages to ${path.relative(repoRoot, result.contentDir)}`);
}
