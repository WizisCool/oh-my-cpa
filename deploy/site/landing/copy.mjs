/**
 * Bilingual copy, navigation metadata, and sample fixture rows for the public landing page.
 */
import { AGENT_GUIDE_URL, CPA_URL, GITHUB_URL, RELEASES_DOWNLOAD_URL } from '../site-meta.mjs';

export const LANDING_PAGES = [
  { lang: 'en', path: '/', file: 'index.html', hreflang: 'en' },
  { lang: 'zh', path: '/zh/', file: 'zh/index.html', hreflang: 'zh-CN' },
];

/**
 * The commands behind each install step, keyed by the name a step refers to (`install.tabs`).
 * Long commands fold with shell line continuations, so they read cleanly in a narrow block and
 * still paste as they are.
 */
export function installCode(keyPlaceholder) {
  return {
    files: [
      'mkdir -p oh-my-cpa && cd oh-my-cpa',
      `curl -fsSL \\\n  ${RELEASES_DOWNLOAD_URL}/compose.full.yml \\\n  -o compose.yml`,
      `curl -fsSL \\\n  ${RELEASES_DOWNLOAD_URL}/cpa.config.example.yaml \\\n  -o config.yaml`,
    ],
    keys: [
      `printf 'CPA_MANAGEMENT_KEY=%s\\nOMCPA_MASTER_KEY=%s\\n' \\\n  "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > .env`,
      'chmod 600 .env',
    ],
    start: ['docker compose up -d'],
    consoleFiles: ['mkdir -p oh-my-cpa && cd oh-my-cpa', `curl -fsSL \\\n  ${RELEASES_DOWNLOAD_URL}/compose.omc.yml \\\n  -o compose.yml`],
    connect: [
      `printf 'OMCPA_CPA_BASE_URL=http://host.docker.internal:8317\\nOMCPA_MASTER_KEY=%s\\n' \\\n  "$(openssl rand -hex 32)" > .env`,
      `cat >> .env <<'EOF'\nOMCPA_CPA_MANAGEMENT_KEY='${keyPlaceholder}'\nEOF`,
      'chmod 600 .env',
    ],
  };
}

export const COPY = {
  en: {
    htmlLang: 'en',
    title: 'Oh My CPA: the self-hosted AI gateway console',
    description:
      'Centralize APIs, OAuth and routing, and observe requests, quota and cost. Open source and self-hosted beside CLIProxyAPI, with a built-in agent and MCP.',
    ogAlt: 'The Oh My CPA dashboard in light and dark themes',
    skip: 'Skip to content',
    nav: {
      docs: 'Docs',
      api: 'API',
      demo: 'Demo',
      github: 'GitHub',
      theme: 'Switch theme',
      toDark: 'Switch to dark theme',
      toLight: 'Switch to light theme',
      language: '中文',
      home: 'Oh My CPA home',
      start: 'Quick start',
    },
    starBanner: {
      text: 'Open source under MIT — if Oh My CPA helps you, give it a star on GitHub',
      cta: 'Star on GitHub',
      close: 'Dismiss banner',
    },
    docs: '/docs/en',
    release: (version) => `<strong data-release-version>v${version}</strong> release notes`,
    hero: {
      lead: 'Centralize APIs, OAuth and routing, observe requests, quota and cost. Open source, self-hosted.',
      primary: 'Quick start',
      secondary: 'Live demo',
      github: 'GitHub',
    },
    console: {
      caption:
        'An operator asks the Oh My CPA agent to compare requests and failure rates by provider over the last 24 hours, sees Codex is failing due to team-2 nearing its 5-hour limit, and approves moving team-3 to the top of the Codex route with an automatic configuration backup.',
      nav: [
        ['Operate', [['layout-grid', 'Dashboard'], ['bot', 'Agent'], ['square-terminal', 'Playground'], ['boxes', 'Model Square']]],
        ['Gateway', [['server', 'AI providers'], ['log-in', 'OAuth management'], ['key-round', 'Key management'], ['layers', 'Routing']]],
        ['Observe', [['chart-line', 'Insights'], ['history', 'Request Events'], ['dollar-sign', 'Model Pricing'], ['file-text', 'Logs'], ['scroll-text', 'Audit trail']]],
        ['Plugins', [['puzzle', 'Plugin management'], ['store', 'Plugin store']]],
        ['Control', [['sliders-horizontal', 'Config panel'], ['settings', 'OMC settings'], ['info', 'System info']]],
      ],
      crumb: ['Operate', 'Agent'],
      placeholder: 'Ask or operate this deployment',
      mode: 'Chat',
      u1: 'Compare requests and failure rate by provider over the last 24 hours',
      thinking: 'Thinking',
      readTools: ['Read 24h usage summary', 'Read OAuth quota & health'],
      a1: '1,284 requests in the last 24 hours, 98.8% succeeded. <b>Codex</b> had the highest failure rate (4.1%), mostly from account <b>team-2</b> hitting 92% of its 5-hour window.',
      compare: {
        cols: ['Provider', 'Requests', 'Failure rate'],
        rows: [
          ['codex', 'Codex', '512', '4.1%', 82, 'warn'],
          ['claude', 'Claude', '418', '0.5%', 10, 'ok'],
          ['gemini', 'Gemini', '246', '0.4%', 8, 'ok'],
          ['openrouter', 'OpenRouter', '108', '0.0%', 0, 'ok'],
        ],
      },
      u2: 'Move the highest-quota Codex credential to top priority',
      planTool: 'Read OAuth quota & draft routing plan',
      a2: 'team-3 has 81% of its 5-hour window left. This plan puts it first and team-2 second, saving an encrypted configuration backup before applying.',
      approval: { title: 'Waiting for your approval', approved: 'Approved', route: 'Codex route', approve: 'Approve', diff: 'View diff' },
      a3: '<b>team-3</b> is now top priority on the Codex route, with team-2 moved to second. The routing board is at revision 42, and the pre-change encrypted backup has been saved.',
    },
    beside: {
      title: 'Beside your gateway',
      body: [
        'Clients keep talking straight to CLIProxyAPI, with no extra hop in your inference path. Oh My CPA reads the management API to record every request, latency and cost locally.',
        'Your gateway stays independent either way. Open the console on desktop or mobile to manage providers, OAuth accounts, routing and live usage in one place.',
      ],
      providersLabel: 'Supported providers and protocols',
      providers: [
        ['claude', 'Claude'],
        ['codex', 'Codex'],
        ['gemini', 'Gemini'],
        ['antigravity', 'Antigravity'],
        ['kimi', 'Kimi'],
        ['xai', 'xAI'],
        ['devin', 'Devin'],
        ['meta', 'Meta Muse'],
        ['vertex', 'Vertex AI'],
        ['deepseek', 'DeepSeek'],
        ['opencode', 'OpenCode'],
        ['openai', 'OpenAI compatible'],
        ['anthropic', 'Anthropic (Messages)'],
      ],
    },
    map: {
      title: 'See how models route to credentials',
      modelsHead: 'Models called',
      credentialsHead: 'Credentials & providers',
      requests: '{count} req',
      clients: [
        ['claude', 'claude-opus-5.5', '418', '0,3'],
        ['openai', 'gpt-6-astra', '512', '1,2'],
        ['gemini', 'gemini-4-hydrogen', '246', '3'],
        ['deepseek', 'deepseek-v4.1-flash', '108', '4'],
      ],
      credentials: [
        ['claude', 'Claude', 'claude-max (OAuth)'],
        ['codex', 'Codex', 'team-3 (OAuth)'],
        ['codex', 'Codex', 'team-2 (OAuth)'],
        ['antigravity', 'Antigravity', 'ag-pro (OAuth)'],
        ['openai', 'OpenAI compatible', 'relay-de••••••••mary'],
      ],
      stats: ['Requests', 'Spent'],
      caption: 'Model calls enter Oh My CPA and route across OAuth credentials and OpenAI-compatible endpoints.',
    },
    features: {
      title: 'Everything your gateway does, in plain sight',
      cards: {
        requests: { title: 'Every request, accounted for', body: 'Records stream in live with model, account, tokens, latency and cost.' },
        cost: { title: 'Know what each model costs', body: 'Prices follow the OpenRouter catalog, and each request keeps the price it was billed at.' },
        oauth: { title: 'OAuth accounts that stay ready', body: 'Watch every quota window and warm accounts on a schedule, so capacity is there when work starts.' },
        receipt: { title: 'A daily receipt you can print', body: 'Generate a usage receipt for today or any range, ready to copy, export or print.' },
      },
      columns: { time: 'Time', model: 'Model', account: 'Account', tokens: 'Tokens', cost: 'Cost' },
      costTotal: 'Last 30 days',
      windows: ['5h', '7d'],
      warming: 'Warming',
      ready: 'Ready',
      receipt: {
        title: 'TODAY’S RECEIPT',
        tagline: 'Metered by Oh My CPA',
        totalLabel: 'API COST TOTAL',
        total: '$18.42',
        summary: [
          ['Requests', '1,284'],
          ['Success rate', '99.2%'],
          ['vs previous', '-12.4%', 'down'],
        ],
        itemsHead: ['KEY / MODEL', 'REQ', 'COST'],
      },
    },
    install: {
      title: 'Up in about three minutes',
      tabs: [
        {
          id: 'compose',
          label: 'New stack',
          link: { href: '/start/quickstart', text: 'Read the quickstart' },
          steps: [
            ['Get the files', 'The Compose file and the gateway configuration.', 'files'],
            ['Make the keys', 'One to sign in, one to encrypt local data.', 'keys'],
            ['Start', 'Then open <code>http://127.0.0.1:8080</code> and sign in with <code>CPA_MANAGEMENT_KEY</code> from <code>.env</code>.', 'start'],
          ],
        },
        {
          id: 'agent',
          label: 'Coding agent',
          link: { href: '/start/agent', text: 'What the agent does' },
          steps: [
            ['Copy one sentence', 'It points to an install guide written for agents.', 'prompt'],
            ['Paste it to your agent', 'Claude Code, Codex or Cursor. It reports the console address when done.'],
          ],
        },
        {
          id: 'standalone',
          label: 'Existing CPA',
          link: { href: '/install', text: 'Choose an install path' },
          steps: [
            ['Get the console', 'The Compose file for Oh My CPA.', 'consoleFiles'],
            ['Connect CPA', 'Fill in its management key; CPA itself stays as it is.', 'connect'],
            ['Start', 'Then open <code>http://127.0.0.1:8080</code> and sign in with the CPA management key.', 'start'],
          ],
        },
      ],
      agentPrompt: `Install Oh My CPA for me by following ${AGENT_GUIDE_URL}`,
      keyPlaceholder: '<CPA management key>',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed',
    },
    faqTitle: 'Questions',
    faq: [
      [
        'What is CLIProxyAPI?',
        `An open-source gateway that serves OpenAI, Claude and Gemini compatible APIs from your provider keys and OAuth accounts. <a href="${CPA_URL}">CLIProxyAPI</a> handles the traffic; Oh My CPA is its console.`,
      ],
      [
        'Will it change my gateway configuration?',
        'Only when you save a change in the console. Each save checks the revision, lists the paths it touches and keeps an encrypted copy of the previous file to download or restore.',
      ],
      ['Where does my data live?', 'Usage records, settings and encrypted secrets live in one SQLite database on your machine. There is no hosted service behind the console.'],
      ['Can my own agents use it?', 'Yes. The capabilities the built-in agent uses are open over MCP, and anything that changes state waits for an administrator to approve it in the browser.'],
      ['How do updates work?', 'The console checks GitHub releases and, with the updater running, upgrades in one click. The updater keeps the previous container until the new one is healthy.'],
      ['What does it cost?', `Nothing. Oh My CPA is open source under the MIT license, and the <a href="${GITHUB_URL}">source is on GitHub</a>.`],
    ],
    cta: { title: 'Try it now', lead: 'The live demo runs on sample data, with nothing to install.' },
    footer: {
      navLabel: 'Open-source links',
      demo: 'Live demo',
      api: 'API reference',
      docs: 'Docs',
      releases: 'Releases',
      github: 'GitHub',
      issues: 'Issues',
      cpa: 'CLIProxyAPI',
      license: 'MIT License',
    },
  },
  zh: {
    htmlLang: 'zh-CN',
    title: 'Oh My CPA：自托管的 AI 网关控制台',
    description:
      '集中管理 API、OAuth 与路由，可视化观测请求、配额与成本。开源、自托管，运行在 CLIProxyAPI 旁，内置 Agent 与 MCP。',
    ogAlt: 'Oh My CPA 仪表盘的浅色与深色主题',
    skip: '跳到正文',
    nav: {
      docs: '文档',
      api: 'API',
      demo: '演示',
      github: 'GitHub',
      theme: '切换主题',
      toDark: '切换到深色主题',
      toLight: '切换到浅色主题',
      language: 'English',
      home: 'Oh My CPA 首页',
      start: '快速开始',
    },
    starBanner: {
      text: '开源项目需要你的支持 — 觉得好用欢迎去 GitHub 点一颗 Star',
      cta: '前往 Star',
      close: '关闭横幅',
    },
    docs: '/docs/zh',
    release: (version) => `<strong data-release-version>v${version}</strong> 版本说明`,
    hero: {
      lead: '集中管理 API、OAuth 与路由，可视化观测请求、配额与成本。开源，自托管。',
      primary: '快速开始',
      secondary: '在线演示',
      github: 'GitHub 仓库',
    },
    console: {
      caption: '操作员让 Oh My CPA 的 Agent 对比最近 24 小时各提供商的请求数与失败率，发现 Codex 因 team-2 接近 5 小时限额导致失败率偏高，随后批准将 team-3 调到 Codex 路由第一优先级并自动保存配置备份。',
      nav: [
        ['运行', [['layout-grid', '仪表盘'], ['bot', '智能体'], ['square-terminal', '操练场'], ['boxes', '模型广场']]],
        ['网关', [['server', 'AI 提供商'], ['log-in', 'OAuth 管理'], ['key-round', '密钥管理'], ['layers', '路由编排']]],
        ['观测', [['chart-line', '洞察'], ['history', '请求记录'], ['dollar-sign', '模型定价'], ['file-text', '日志查看'], ['scroll-text', '操作审计']]],
        ['插件', [['puzzle', '插件管理'], ['store', '插件商店']]],
        ['控制', [['sliders-horizontal', '配置面板'], ['settings', 'OMC 设置'], ['info', '系统信息']]],
      ],
      crumb: ['运行', '智能体'],
      placeholder: '询问或操作这个部署',
      mode: 'Chat',
      u1: '对比最近 24 小时各提供商的请求数与失败率',
      thinking: '思考中',
      readTools: ['读取最近 24 小时用量摘要', '读取 OAuth 配额与健康状态'],
      a1: '最近 24 小时共 1,284 个请求，整体成功率 98.8%。<b>Codex</b> 失败率最高（4.1%），主要由账号 <b>team-2</b> 的 5 小时窗口已用 92% 触发限流所致。',
      compare: {
        cols: ['提供商', '请求数', '失败率'],
        rows: [
          ['codex', 'Codex', '512', '4.1%', 82, 'warn'],
          ['claude', 'Claude', '418', '0.5%', 10, 'ok'],
          ['gemini', 'Gemini', '246', '0.4%', 8, 'ok'],
          ['openrouter', 'OpenRouter', '108', '0.0%', 0, 'ok'],
        ],
      },
      u2: '把额度最高的 Codex 凭据调整为第一优先级',
      planTool: '读取 OAuth 配额并生成路由方案',
      a2: 'team-3 的 5 小时窗口还剩 81%。此方案将其调到第一优先级、team-2 降为第二，应用前会先保存一份加密配置备份。',
      approval: { title: '等待你的批准', approved: '已批准', route: 'Codex 路由', approve: '批准', diff: '查看差异' },
      a3: '已将 <b>team-3</b> 设为 Codex 路由第一优先级（team-2 降至第二），路由看板已更新至版本 42，变更前的加密配置备份已保存。',
    },
    beside: {
      title: '运行在网关旁',
      body: [
        '客户端照常直连你的 CLIProxyAPI 网关，不改接入方式，也不增加转发链路。Oh My CPA 只通过旁路管理接口同步状态，将每一笔请求的明细、耗时与费用沉淀到本地。',
        '网关本身始终独立稳定运行，不受控制台启停影响。打开浏览器，就能在桌面和手机上统一打理提供商、OAuth 账号、路由策略与实时用量。',
      ],
      providersLabel: '支持的提供商与协议',
      providers: [
        ['claude', 'Claude'],
        ['codex', 'Codex'],
        ['gemini', 'Gemini'],
        ['antigravity', 'Antigravity'],
        ['kimi', 'Kimi'],
        ['xai', 'xAI'],
        ['devin', 'Devin'],
        ['meta', 'Meta Muse'],
        ['vertex', 'Vertex AI'],
        ['deepseek', 'DeepSeek'],
        ['opencode', 'OpenCode'],
        ['openai', 'OpenAI 兼容'],
        ['anthropic', 'Anthropic (Messages)'],
      ],
    },
    map: {
      title: '看清每次模型调用的实时路由',
      modelsHead: '调用模型',
      credentialsHead: '凭据与提供商',
      requests: '{count} 次',
      clients: [
        ['claude', 'claude-opus-5.5', '418', '0,3'],
        ['openai', 'gpt-6-astra', '512', '1,2'],
        ['gemini', 'gemini-4-hydrogen', '246', '3'],
        ['deepseek', 'deepseek-v4.1-flash', '108', '4'],
      ],
      credentials: [
        ['claude', 'Claude', 'claude-max (OAuth)'],
        ['codex', 'Codex', 'team-3 (OAuth)'],
        ['codex', 'Codex', 'team-2 (OAuth)'],
        ['antigravity', 'Antigravity', 'ag-pro (OAuth)'],
        ['openai', 'OpenAI 兼容', 'relay-de••••••••mary'],
      ],
      stats: ['请求', '花费'],
      caption: '模型请求进入 Oh My CPA 后实时分配到对应的 OAuth 凭据或 OpenAI 兼容端点。',
    },
    features: {
      title: '网关的一切，尽在眼前',
      cards: {
        requests: { title: '每个请求都有账可查', body: '请求记录实时推送，包含模型、账号、Token、延迟与成本。' },
        cost: { title: '清楚每个模型的花费', body: '价格取自 OpenRouter 目录，每个请求都保留计费时的价格。' },
        oauth: { title: 'OAuth 账号随时可用', body: '查看每个额度窗口，并按计划预热，开工时额度已经就绪。' },
        receipt: { title: '一张可打印的每日账单', body: '一键生成每日或任意周期的账单小票，支持复制、导出与打印。' },
      },
      columns: { time: '时间', model: '模型', account: '账号', tokens: 'Token', cost: '成本' },
      costTotal: '近 30 天',
      windows: ['5 小时', '7 天'],
      warming: '预热中',
      ready: '已就绪',
      receipt: {
        title: '今日账单',
        tagline: '经 Oh My CPA 统计',
        totalLabel: 'API 费用合计',
        total: '$18.42',
        summary: [
          ['请求数', '1,284'],
          ['成功率', '99.2%'],
          ['较上期', '-12.4%', 'down'],
        ],
        itemsHead: ['密钥 / 模型', '请求', '费用'],
      },
    },
    install: {
      title: '约三分钟完成部署',
      tabs: [
        {
          id: 'compose',
          label: '全新部署',
          link: { href: '/start/quickstart', text: '阅读快速开始' },
          steps: [
            ['取得部署文件', 'Compose 文件与网关配置。', 'files'],
            ['生成密钥', '一把用于登录，一把加密本地数据。', 'keys'],
            ['启动', '随后打开 <code>http://127.0.0.1:8080</code>，用 <code>.env</code> 中的 <code>CPA_MANAGEMENT_KEY</code> 登录。', 'start'],
          ],
        },
        {
          id: 'agent',
          label: 'Agent 安装',
          link: { href: '/start/agent', text: 'Agent 会做什么' },
          steps: [
            ['复制这句话', '它指向一份写给 Agent 的安装指南。', 'prompt'],
            ['交给 Agent', '粘贴到 Claude Code、Codex 或 Cursor，完成后它会告诉你控制台地址。'],
          ],
        },
        {
          id: 'standalone',
          label: '已有 CPA',
          link: { href: '/install', text: '选择安装方式' },
          steps: [
            ['取得控制台', 'Oh My CPA 的 Compose 文件。', 'consoleFiles'],
            ['连接 CPA', '填入 CPA 的管理密钥，CPA 本身保持原样。', 'connect'],
            ['启动', '随后打开 <code>http://127.0.0.1:8080</code>，用 CPA 的管理密钥登录。', 'start'],
          ],
        },
      ],
      agentPrompt: `请按照 ${AGENT_GUIDE_URL} 为我安装 Oh My CPA`,
      keyPlaceholder: '<CPA 管理密钥>',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败',
    },
    faqTitle: '常见问题',
    faq: [
      [
        'CLIProxyAPI 是什么？',
        `一个开源网关，用你的提供商密钥与 OAuth 账号对外提供 OpenAI、Claude 与 Gemini 兼容接口。<a href="${CPA_URL}">CLIProxyAPI</a> 负责转发流量，Oh My CPA 是它的控制台。`,
      ],
      ['它会修改我的网关配置吗？', '只在你于控制台中保存变更时修改。每次保存都会校验版本、列出涉及的路径，并保留上一版文件的加密副本，可随时下载或恢复。'],
      ['我的数据存放在哪里？', '用量记录、设置与加密后的密钥都保存在你机器上的一个 SQLite 数据库中。控制台背后没有任何托管服务。'],
      ['我自己的 Agent 能用吗？', '可以。内置 Agent 使用的能力通过 MCP 开放，任何会改变状态的操作都要等管理员在浏览器中批准。'],
      ['如何更新？', '控制台会检查 GitHub 版本发布；运行更新器时可一键升级。更新器会保留旧容器，直到新版本健康运行。'],
      ['需要付费吗？', `不需要。Oh My CPA 以 MIT 许可证开源，<a href="${GITHUB_URL}">源码托管在 GitHub</a>。`],
    ],
    cta: { title: '现在就试试', lead: '在线演示使用示例数据，无需安装。' },
    footer: {
      navLabel: '开源链接',
      demo: '在线演示',
      api: 'API 参考',
      docs: '文档',
      releases: '版本发布',
      github: 'GitHub',
      issues: '问题反馈',
      cpa: 'CLIProxyAPI',
      license: 'MIT 开源协议',
    },
  },
};

// Sample rows for the request and cost cards. Model names follow the demo deployment.
export const REQUEST_ROWS = [
  ['claude', 'claude-opus-5.5', 'claude-max', '18.2K', '$0.214', 'ok'],
  ['codex', 'gpt-6-luna', 'team-3', '9.6K', '$0.041', 'ok'],
  ['gemini', 'gemini-4-hydrogen', 'gemini-pro', '42.7K', '$0.087', 'ok'],
  ['codex', 'gpt-6-luna', 'team-2', '3.1K', '$0.013', 'fail'],
  ['deepseek', 'deepseek-v4.1-flash', 'router-key', '6.4K', '$0.004', 'ok'],
  ['claude', 'claude-opus-5.5', 'claude-max', '27.9K', '$0.318', 'ok'],
  ['codex', 'gpt-6-luna', 'team-3', '12.0K', '$0.052', 'ok'],
  ['gemini', 'gemini-4-hydrogen', 'gemini-pro', '8.8K', '$0.019', 'ok'],
];

export const COST_MODELS = [
  ['gemini', 'gemini-4-hydrogen', 41.2, 25],
  ['claude', 'claude-opus-5.5', 38.6, 23],
  ['codex', 'gpt-6-luna', 33.1, 20],
  ['deepseek', 'deepseek-v4.1-flash', 21.4, 13],
  ['openrouter', 'glm-5.3-flash', 18.9, 11],
];

export const OAUTH_ROWS = [
  ['claude', 'claude-max', [64, 82]],
  ['codex', 'team-3', [81, 57]],
  ['codex', 'team-2', [8, 34]],
  ['gemini', 'gemini-pro', [100, 100], 'warm'],
];

export const RECEIPT_LINES = [
  ['claude', 'claude-opus-5.5', '418', '$8.94'],
  ['codex', 'gpt-6-luna', '512', '$5.62'],
  ['gemini', 'gemini-4-hydrogen', '246', '$2.96'],
];
