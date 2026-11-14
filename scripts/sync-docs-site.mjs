import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GITHUB_WEB = 'https://github.com/WizisCool/oh-my-cpa';

function readBranch(repoRoot) {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    if (out && out !== 'HEAD') return out;
  } catch {
    // Fallback to main in detached/non-git staging builds.
  }
  return 'main';
}

export const DOCS_PAGES = [
  // Root index: README.md / README.zh-CN.md
  {
    enSource: 'README.md',
    zhSource: 'README.zh-CN.md',
    slug: 'index',
    enTitle: 'Introduction',
    zhTitle: '简介',
    enDescription: 'Self-hosted web console, routing workspace, and usage observability layer for CLIProxyAPI v8+.',
    zhDescription: '面向 CLIProxyAPI v8+ 的自托管控制台、路由编排与用量可观测平台。',
    icon: 'BookOpen',
    stripLeadingTitle: false,
    isReadme: true,
  },
  // Getting Started
  {
    enSource: 'docs/install.md',
    zhSource: 'docs/zh/install.md',
    slug: 'getting-started/install',
    enTitle: 'Installation',
    zhTitle: '安装指南',
    enDescription: 'Deploy Oh My CPA with Docker Compose, native executables, or source builds, plus upgrades and troubleshooting.',
    zhDescription: '通过 Docker Compose、原生可执行文件或源码部署 Oh My CPA，包含反向代理、升级与排障。',
    icon: 'Download',
    stripLeadingTitle: true,
  },
  {
    enSource: 'docs/install-for-agents.md',
    zhSource: 'docs/zh/install-for-agents.md',
    slug: 'getting-started/install-for-agents',
    enTitle: 'Install with an Agent',
    zhTitle: 'Agent 自动安装规范',
    enDescription: 'Preflight, authorization, configuration, and verification rules for coding agents installing Oh My CPA.',
    zhDescription: '供编码 Agent 执行安装时的环境预检、安全授权、配置与验收规范。',
    icon: 'Bot',
    stripLeadingTitle: true,
  },
  // Operations & Security
  {
    enSource: 'docs/operations.md',
    zhSource: 'docs/zh/operations.md',
    slug: 'operations/configuration',
    enTitle: 'Configuration & Operations',
    zhTitle: '配置与运维指南',
    enDescription: 'Environment variables, security constraints, container updater, Agent/MCP, quota refresh, and warmup.',
    zhDescription: '全量环境变量参考、安全运行约束、自动更新器、Agent/MCP、模型目录与配额预热。',
    icon: 'Settings',
    stripLeadingTitle: true,
  },
  {
    enSource: 'docs/ops/sqlite-operations.md',
    zhSource: 'docs/zh/ops/sqlite-operations.md',
    slug: 'operations/sqlite-backup-restore',
    enTitle: 'SQLite Backup & Recovery',
    zhTitle: 'SQLite 备份与恢复',
    enDescription: 'Single-replica WAL invariants, encrypted .omcbackup exports, cloud recovery, and OMCPA_MASTER_KEY governance.',
    zhDescription: '单副本 WAL 约束、控制台 .omcbackup 加密备份、云端容灾恢复与主密钥治理。',
    icon: 'DatabaseBackup',
    stripLeadingTitle: true,
  },
  // Integration & Billing
  {
    enSource: 'docs/pricing.md',
    zhSource: 'docs/zh/pricing.md',
    slug: 'guides/pricing',
    enTitle: 'Pricing & Cost Accounting',
    zhTitle: '定价与费用核算',
    enDescription: 'OpenRouter price matching, tiered rates, channel multipliers, and immutable request cost snapshots.',
    zhDescription: 'OpenRouter 自动定价匹配、阶梯费率、渠道倍率与不可变请求费用快照。',
    icon: 'Coins',
    stripLeadingTitle: true,
  },
  {
    enSource: 'docs/agent-capabilities.md',
    zhSource: 'docs/zh/agent-capabilities.md',
    slug: 'guides/agent-and-mcp',
    enTitle: 'Agent Capabilities & MCP',
    zhTitle: '智能体能力与 MCP 接入',
    enDescription: 'Shared capability registry, human approval handoffs, read-only SQL bounds, and MCP transports.',
    zhDescription: '共享能力注册表、敏感操作人工审批、只读 SQL 边界与 Streamable HTTP / stdio 接入。',
    icon: 'Cpu',
    stripLeadingTitle: true,
  },
  {
    enSource: 'docs/cpa-v8-compat.md',
    zhSource: 'docs/zh/cpa-v8-compat.md',
    slug: 'guides/cpa-v8-contract',
    enTitle: 'CLIProxyAPI v8 Contract',
    zhTitle: 'CLIProxyAPI v8 契约',
    enDescription: 'Gateway v8 capability probing, write coalescing, plugin boundaries, and credential recovery.',
    zhDescription: '网关 v8 门禁探测、250ms 写合并、插件边界与精确凭据定向重登。',
    icon: 'Plug',
    stripLeadingTitle: true,
  },
  // Reference / Developer pointers
  {
    enSource: 'CONTEXT.md',
    zhSource: 'CONTEXT.md',
    slug: 'reference/glossary',
    enTitle: 'Domain Glossary',
    zhTitle: '领域术语表（EN）',
    enDescription: 'Canonical Oh My CPA domain terms across identity, usage, billing, and automation.',
    zhDescription: 'Oh My CPA 领域核心术语定义（英文原文）。',
    icon: 'Layers',
    stripLeadingTitle: true,
    zhNotice: '本页词汇表当前以仓库英文原文发布。',
  },
  {
    enSource: 'docs/dev/architecture.md',
    zhSource: 'docs/dev/architecture.md',
    slug: 'reference/architecture',
    enTitle: 'Architecture & Security',
    zhTitle: '系统架构与安全边界（EN）',
    enDescription: 'Module ownership, session and plugin trust boundaries, write gates, and frontend distribution.',
    zhDescription: '模块边界、会话与插件安全边界、写门禁及前端交付说明（英文原文）。',
    icon: 'ShieldCheck',
    stripLeadingTitle: true,
    zhNotice: '面向开发者的系统架构文档当前以仓库英文原文发布。',
  },
  {
    enSource: 'CONTRIBUTING.md',
    zhSource: 'CONTRIBUTING.md',
    slug: 'reference/contributing',
    enTitle: 'Contributing',
    zhTitle: '参与贡献（EN）',
    enDescription: 'Local development workflow, verification pyramid, and contribution guidelines.',
    zhDescription: '本地开发调试、验证命令与贡献规范（英文原文）。',
    icon: 'GitPullRequest',
    stripLeadingTitle: true,
    zhNotice: '面向贡献者的开发文档当前以仓库英文原文发布。',
  },
];

export const META_FILES = [
  {
    file: 'meta.json',
    data: {
      title: 'Documentation',
      pages: ['index', 'getting-started', 'operations', 'guides', 'reference'],
    },
  },
  {
    file: 'meta.zh.json',
    data: {
      title: '文档',
      pages: ['index', 'getting-started', 'operations', 'guides', 'reference'],
    },
  },
  {
    file: 'getting-started/meta.json',
    data: {
      title: 'Getting Started',
      pages: ['install', 'install-for-agents'],
    },
  },
  {
    file: 'getting-started/meta.zh.json',
    data: {
      title: '快速开始',
      pages: ['install', 'install-for-agents'],
    },
  },
  {
    file: 'operations/meta.json',
    data: {
      title: 'Operations & Security',
      pages: ['configuration', 'sqlite-backup-restore'],
    },
  },
  {
    file: 'operations/meta.zh.json',
    data: {
      title: '配置与运维',
      pages: ['configuration', 'sqlite-backup-restore'],
    },
  },
  {
    file: 'guides/meta.json',
    data: {
      title: 'Integration & Billing',
      pages: ['pricing', 'agent-and-mcp', 'cpa-v8-contract'],
    },
  },
  {
    file: 'guides/meta.zh.json',
    data: {
      title: '集成与计费',
      pages: ['pricing', 'agent-and-mcp', 'cpa-v8-contract'],
    },
  },
  {
    file: 'reference/meta.json',
    data: {
      title: 'Architecture & Reference',
      pages: ['glossary', 'architecture', 'contributing'],
    },
  },
  {
    file: 'reference/meta.zh.json',
    data: {
      title: '架构与参考',
      pages: ['glossary', 'architecture', 'contributing'],
    },
  },
];

export function buildSourceLinkMap() {
  const map = new Map();
  for (const page of DOCS_PAGES) {
    const outEn = page.slug === 'index' ? '/en/' : `/en/${page.slug}/`;
    const outZh = page.slug === 'index' ? '/zh/' : `/zh/${page.slug}/`;
    if (page.enSource === page.zhSource) {
      map.set(path.posix.normalize(page.enSource), { en: outEn, zh: outZh });
    } else {
      map.set(path.posix.normalize(page.enSource), { en: outEn, zh: outEn });
      map.set(path.posix.normalize(page.zhSource), { en: outZh, zh: outZh });
    }
  }
  map.set('README.md', { en: '/en/', zh: '/en/' });
  map.set('README.zh-CN.md', { en: '/zh/', zh: '/zh/' });
  map.set('docs/README.md', { en: '/en/', zh: '/en/' });
  map.set('docs/zh/README.md', { en: '/zh/', zh: '/zh/' });
  return map;
}

function escapeJsxText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function rewriteMarkdownForMdx(markdown, {
  sourcePath,
  lang,
  repoRoot,
  sourceLinkMap,
  branch,
  isReadme = false,
  stripLeadingTitle = true,
  zhNotice = '',
}) {
  let text = markdown.replace(/\r\n/g, '\n');

  if (isReadme) {
    // Strip the GitHub-only README centered header banner + badges + first hero table, keeping concise intro.
    const firstEndDiv = text.indexOf('</div>');
    if (firstEndDiv !== -1) {
      text = text.slice(firstEndDiv + '</div>'.length).trimStart();
    }
    // Strip GitHub theme-only tags if any remain.
    text = text.replace(/<a href="#gh-(?:dark|light)-mode-only">[\s\S]*?<\/a>/g, '');
  } else if (stripLeadingTitle) {
    text = text.replace(/^#\s+[^\n]+\n+/, '');
  }

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

  // Convert raw HTML <table>...</table> screenshot gallery in README to responsive Markdown/JSX cards.
  text = text.replace(/<table>[\s\S]*?<\/table>/g, (tableHtml) => {
    const cards = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let match;
    while ((match = tdRegex.exec(tableHtml)) !== null) {
      const cell = match[1];
      const imgMatch = cell.match(/<img\s+src="([^"]+)"\s+alt="([^"]*)"[^>]*>/);
      const titleMatch = cell.match(/<b>([\s\S]*?)<\/b>(?:<br\s*\/?>([\s\S]*?))?<\/p>/);
      if (imgMatch) {
        const src = `/docs/images/${path.posix.basename(imgMatch[1])}`;
        const alt = imgMatch[2];
        const title = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').trim() : alt;
        const caption = titleMatch && titleMatch[2] ? titleMatch[2].replace(/&amp;/g, '&').trim() : '';
        cards.push({ src, alt, title, caption });
      }
    }
    if (cards.length === 0) return '';
    return [
      '<div className="grid grid-cols-1 gap-4 md:grid-cols-2 my-6">',
      ...cards.map(
        (c) =>
          `  <figure className="m-0 overflow-hidden rounded-lg border border-fd-border bg-fd-card">\n    <img src="${c.src}" alt="${c.alt.replaceAll('"', '&quot;')}" loading="lazy" className="m-0 w-full border-0 rounded-none" />\n    <figcaption className="px-3.5 py-2.5 text-sm"><strong className="block font-medium text-fd-foreground">${escapeJsxText(c.title)}</strong>${c.caption ? `<span className="text-xs text-fd-muted-foreground">${escapeJsxText(c.caption)}</span>` : ''}</figcaption>\n  </figure>`,
      ),
      '</div>',
    ].join('\n');
  });

  // Convert standalone <div align="center">...</div> mobile showcase in README.
  text = text.replace(/<div align="center">([\s\S]*?)<\/div>/g, (_full, inner) => {
    const imgMatch = inner.match(/<img\s+src="([^"]+)"\s+alt="([^"]*)"[^>]*>/);
    const titleMatch = inner.match(/<b>([\s\S]*?)<\/b>(?:<br\s*\/?>([\s\S]*?))?<\/p>/);
    if (!imgMatch) return '';
    const src = `/docs/images/${path.posix.basename(imgMatch[1])}`;
    const alt = imgMatch[2];
    const title = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').trim() : alt;
    const caption = titleMatch && titleMatch[2] ? titleMatch[2].replace(/&amp;/g, '&').trim() : '';
    return `<figure className="my-6 overflow-hidden rounded-lg border border-fd-border bg-fd-card">\n  <img src="${src}" alt="${alt.replaceAll('"', '&quot;')}" loading="lazy" className="m-0 mx-auto max-h-[540px] w-auto border-0 rounded-none" />\n  <figcaption className="px-4 py-3 text-center text-sm"><strong className="block font-medium text-fd-foreground">${escapeJsxText(title)}</strong>${caption ? `<span className="text-xs text-fd-muted-foreground">${escapeJsxText(caption)}</span>` : ''}</figcaption>\n</figure>`;
  });

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

function formatFrontmatter({ title, description, icon }) {
  const esc = (v) => JSON.stringify(String(v));
  const lines = ['---', `title: ${esc(title)}`, `description: ${esc(description)}`];
  if (icon) lines.push(`icon: ${esc(icon)}`);
  lines.push('---', '');
  return lines.join('\n');
}

export async function syncDocsSite({ repoRoot }) {
  const docsAppDir = path.join(repoRoot, 'deploy', 'site', 'docs');
  const contentDir = path.join(docsAppDir, 'content', 'docs');
  const publicImagesDir = path.join(docsAppDir, 'public', 'images');
  const readmeImagesDir = path.join(repoRoot, 'docs', 'images', 'readme');
  const branch = readBranch(repoRoot);
  const sourceLinkMap = buildSourceLinkMap();

  fs.rmSync(contentDir, { recursive: true, force: true });
  fs.mkdirSync(contentDir, { recursive: true });

  for (const page of DOCS_PAGES) {
    for (const lang of ['en', 'zh']) {
      const sourceRel = lang === 'zh' ? page.zhSource : page.enSource;
      const sourceAbs = path.join(repoRoot, sourceRel);
      if (!fs.existsSync(sourceAbs)) {
        throw new Error(`Missing docs source file: ${sourceRel}`);
      }
      const rawMarkdown = fs.readFileSync(sourceAbs, 'utf8');
      const body = rewriteMarkdownForMdx(rawMarkdown, {
        sourcePath: sourceRel,
        lang,
        repoRoot,
        sourceLinkMap,
        branch,
        isReadme: Boolean(page.isReadme),
        stripLeadingTitle: page.stripLeadingTitle,
        zhNotice: lang === 'zh' ? page.zhNotice ?? '' : '',
      });
      const frontmatter = formatFrontmatter({
        title: lang === 'zh' ? page.zhTitle : page.enTitle,
        description: lang === 'zh' ? page.zhDescription : page.enDescription,
        icon: page.icon,
      });
      const outName = lang === 'zh' ? `${page.slug}.zh.mdx` : `${page.slug}.mdx`;
      const outAbs = path.join(contentDir, outName);
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, `${frontmatter}\n${body}`);
    }
  }

  for (const meta of META_FILES) {
    const outAbs = path.join(contentDir, meta.file);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, `${JSON.stringify(meta.data, null, 2)}\n`);
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

  return {
    contentDir,
    pageCount: DOCS_PAGES.length * 2,
  };
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(selfPath)) {
  const repoRoot = path.resolve(path.dirname(selfPath), '..');
  const result = await syncDocsSite({ repoRoot });
  console.log(`synced ${result.pageCount} bilingual MDX pages to ${path.relative(repoRoot, result.contentDir)}`);
}
