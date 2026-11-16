/**
 * The client programs request records are attributed to, as the console names them.
 *
 * The server normalises each User-Agent to a short identifier at ingestion; this module only turns
 * that identifier into the product's own spelling and brand. An identifier the console does not
 * know yet is spelled out from its words (`foo-cli` reads `Foo Cli`), so a new client is still told
 * apart. A client without artwork in the local icon catalog takes a terminal or SDK glyph.
 */

import type { InsightsClientItem } from './insights';
import { normalizeMeasures, type Measures } from './insightsCube';

/** Identifiers whose name is a translation rather than a product spelling. */
export const LOCALIZED_CLIENTS = ['browser', 'unknown', 'other'] as const;
export type LocalizedClient = (typeof LOCALIZED_CLIENTS)[number];

const CLIENT_NAMES: Readonly<Record<string, string>> = {
  hermes: 'Hermes Agent',
  'kilo-code': 'Kilo Code',
  'claude-code': 'Claude Code',
  pi: 'Pi',
  'oh-my-pi': 'Oh My Pi (omp)',
  'deepseek-harness': 'DeepSeek Harness',
  strix: 'Strix',
  openclaw: 'OpenClaw',
  'codex-cli': 'Codex',
  'kimi-cli': 'Kimi Code',
  opencode: 'OpenCode',
  'gemini-cli': 'Gemini CLI',
  workbuddy: 'WorkBuddy',
  codebuddy: 'CodeBuddy',
  qoder: 'Qoder',
  zcode: 'ZCode',
  openhands: 'OpenHands',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  'qwen-code': 'Qwen Code',
  cursor: 'Cursor',
  zed: 'Zed',
  'github-copilot': 'GitHub Copilot',
  crush: 'Crush',
  goose: 'Goose',
  amp: 'Amp',
  augment: 'Augment',
  kiro: 'Kiro',
  antigravity: 'Antigravity',
  droid: 'Factory Droid',
  'command-code': 'Command Code',
  codegpt: 'CodeGPT',
  letta: 'Letta',
  'agent-zero': 'Agent Zero',
  mimocode: 'MiMo Code',
  junie: 'JetBrains Junie',
  zencoder: 'Zencoder',
  codeflicker: 'CodeFlicker',
  kode: 'Kode',
  windsurf: 'Windsurf',
  trae: 'TRAE',
  aider: 'Aider',
  continue: 'Continue',
  warp: 'Warp',
  cody: 'Sourcegraph Cody',
  devin: 'Devin',
  manus: 'Manus',
  replit: 'Replit Agent',
  plandex: 'Plandex',
  'swe-agent': 'SWE-agent',
  gptme: 'gptme',
  lovable: 'Lovable',
  v0: 'v0',
  blackbox: 'Blackbox AI',
  pearai: 'PearAI',
  void: 'Void',
  freecode: 'Free Code',
  atomic: 'Atomic Agent',
  'cherry-studio': 'Cherry Studio',
  lobechat: 'LobeChat',
  'open-webui': 'Open WebUI',
  chatbox: 'Chatbox',
  nextchat: 'NextChat',
  anythingllm: 'AnythingLLM',
  librechat: 'LibreChat',
  sillytavern: 'SillyTavern',
  jan: 'Jan',
  msty: 'Msty',
  alma: 'Alma',
  kelivo: 'Kelivo',
  rikkahub: 'RikkaHub',
  chatwise: 'ChatWise',
  typingmind: 'TypingMind',
  dify: 'Dify',
  coze: 'Coze',
  fastgpt: 'FastGPT',
  n8n: 'n8n',
  mastra: 'Mastra',
  crewai: 'CrewAI',
  'pydantic-ai': 'PydanticAI',
  metagpt: 'MetaGPT',
  agno: 'Agno',
  autogen: 'AutoGen',
  smolagents: 'Smolagents',
  dspy: 'DSPy',
  langflow: 'Langflow',
  portkey: 'Portkey AI',
  'openai-sdk': 'OpenAI SDK',
  'anthropic-sdk': 'Anthropic SDK',
  'vercel-ai-sdk': 'Vercel AI SDK',
  langchain: 'LangChain',
  llamaindex: 'LlamaIndex',
  litellm: 'LiteLLM',
  'python-httpx': 'Python HTTPX',
  'python-requests': 'Python Requests',
  aiohttp: 'aiohttp',
  curl: 'cURL',
  undici: 'Undici',
  'node-http': 'Node HTTP',
  'go-http-client': 'Go HTTP',
  axios: 'Axios',
  okhttp: 'OkHttp',
  'oh-my-cpa': 'Oh My CPA',
  hindsight: 'Hindsight',
  'grok-build': 'Grok Build',
  'minimax-code': 'MiniMax Code',
  maka: 'Apache Maka',
  exo: 'Exo Harness',
  graff: 'Graff',
  'muse-code': 'Muse Code',
  'mistral-vibe': 'Mistral Vibe',
  stepcode: 'StepCode',
  mothx: 'MothX',
  'penguin-harness': 'PenguinHarness',
  omo: 'OmO',
  reasonix: 'Reasonix Studio',
  'mister-morph': 'Mister Morph',
  nanobot: 'nanobot',
  astrbot: 'AstrBot',
  shelley: 'Shelley',
  openhanako: 'OpenHanako',
  atomcode: 'AtomCode',
  paimon: 'Paimon',
  'deveco-code': 'DevEco Code',
  paseo: 'Paseo',
  't3-code': 'T3 Code',
  'snow-cli': 'Snow CLI',
  'prime-agent': 'Prime Agent',
  dcode: 'dcode',
  raycast: 'Raycast',
  aionui: 'AionUi',
  'google-genai-sdk': 'Google GenAI SDK',
};

/** The brand artwork a client is recognised by, where the icon catalog carries the product. */
const CLIENT_ICONS: Readonly<Record<string, string>> = {
  hermes: 'HermesAgent',
  'kilo-code': 'KiloCode',
  'claude-code': 'ClaudeCode',
  pi: 'Pi',
  'oh-my-pi': 'Pi',
  'deepseek-harness': 'DeepSeek',
  openclaw: 'OpenClaw',
  'codex-cli': 'Codex',
  'kimi-cli': 'Kimi',
  opencode: 'OpenCode',
  'gemini-cli': 'GeminiCLI',
  workbuddy: 'CodeBuddy',
  codebuddy: 'CodeBuddy',
  qoder: 'Qoder',
  zcode: 'ZAI',
  openhands: 'OpenHands',
  cline: 'Cline',
  'roo-code': 'RooCode',
  'qwen-code': 'Qwen',
  cursor: 'Cursor',
  'github-copilot': 'GithubCopilot',
  goose: 'Goose',
  amp: 'Amp',
  kiro: 'Kiro',
  antigravity: 'Antigravity',
  'command-code': 'CommandCode',
  junie: 'Junie',
  zencoder: 'Zencoder',
  codeflicker: 'CodeFlicker',
  windsurf: 'Windsurf',
  trae: 'Trae',
  devin: 'Devin',
  manus: 'Manus',
  replit: 'Replit',
  lovable: 'Lovable',
  v0: 'V0',
  'cherry-studio': 'CherryStudio',
  lobechat: 'LobeHub',
  'open-webui': 'OpenWebUI',
  sillytavern: 'SillyTavern',
  dify: 'Dify',
  coze: 'Coze',
  fastgpt: 'FastGPT',
  n8n: 'N8n',
  mastra: 'Mastra',
  crewai: 'CrewAI',
  'pydantic-ai': 'PydanticAI',
  metagpt: 'MetaGPT',
  agno: 'Phidata',
  'openai-sdk': 'OpenAI',
  'anthropic-sdk': 'Anthropic',
  'vercel-ai-sdk': 'Vercel',
  langchain: 'LangChain',
  llamaindex: 'LlamaIndex',
  'grok-build': 'Grok',
  'minimax-code': 'Minimax',
  'muse-code': 'Meta',
  'mistral-vibe': 'Mistral',
  stepcode: 'Stepfun',
  'google-genai-sdk': 'Gemini',
};

/** An own entry only: an identifier such as `constructor` must not read `Object.prototype`. */
const hasOwn = (table: object, id: string) => Object.prototype.hasOwnProperty.call(table, id);

export function isLocalizedClient(id: string): id is LocalizedClient {
  return (LOCALIZED_CLIENTS as readonly string[]).includes(id);
}

/** The product spelling of a client, or its identifier spelled out; localized identifiers return undefined. */
export function clientProductName(id: string): string | undefined {
  if (isLocalizedClient(id)) return undefined;
  return hasOwn(CLIENT_NAMES, id) ? CLIENT_NAMES[id] : readableClientId(id);
}

function readableClientId(id: string): string {
  const words = id.split(/[-_\s]+/).filter(Boolean);
  return words.length === 0 ? id : words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
}

export function clientIconId(id: string): string | undefined {
  return hasOwn(CLIENT_ICONS, id) ? CLIENT_ICONS[id] : undefined;
}

/** A client's totals in the cube's normalised measure shape, so they rank, scope and format like any group. */
export function clientMeasures(item: InsightsClientItem): Measures {
  // A server that sends `net_tokens` has partitioned the columns; an older one sends raw records.
  const isPartitioned = typeof item.net_tokens === 'number';
  return normalizeMeasures({
    requests: item.requests,
    failures: item.failures,
    inputTokens: item.input_tokens,
    outputTokens: item.output_tokens,
    reasoningTokens: item.reasoning_tokens,
    cachedTokens: item.cached_tokens,
    cacheReadTokens: item.cache_read_tokens,
    cacheCreationTokens: item.cache_creation_tokens,
    totalTokens: item.total_tokens,
    latencySumMs: item.latency_sum_ms,
    ttftSumMs: item.ttft_sum_ms,
    ttftCount: item.ttft_count,
    costNanos: item.cost_nanos,
    pricedRequests: item.priced_requests,
    costedRequests: item.costed_requests,
    netTokens: isPartitioned ? item.net_tokens! : 0,
    isNormalized: isPartitioned,
  });
}

/** The share of requests the client attribution covers, in percent, when request retention cut it short. */
export function clientCoverageShare(coverage: { total_requests: number; retained_requests: number }): number | null {
  if (coverage.total_requests <= 0 || coverage.retained_requests >= coverage.total_requests) return null;
  return (Math.max(0, coverage.retained_requests) / coverage.total_requests) * 100;
}
