package usage

import (
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// ClientAgentCategory groups normalized caller identities by diagnostic certainty.
type ClientAgentCategory string

const (
	ClientAgentCategoryAgent   ClientAgentCategory = "agent"
	ClientAgentCategorySDK     ClientAgentCategory = "sdk"
	ClientAgentCategoryUnknown ClientAgentCategory = "unknown"
)

// Canonical low-cardinality caller agent, AI client, orchestrator, and SDK
// identifiers persisted on usage_events.client_agent and shared across Insights,
// Request Records, and Dashboard projections.
const (
	ClientAgentUnknown         = "unknown"
	ClientAgentOther           = "other"
	ClientAgentHermes          = "hermes"
	ClientAgentKiloCode        = "kilo-code"
	ClientAgentClaudeCode      = "claude-code"
	ClientAgentPi              = "pi"
	ClientAgentOhMyPi          = "oh-my-pi"
	ClientAgentDeepSeekHarness = "deepseek-harness"
	ClientAgentStrix           = "strix"
	ClientAgentOpenClaw        = "openclaw"
	ClientAgentCodexCLI        = "codex-cli"
	ClientAgentKimiCLI         = "kimi-cli"
	ClientAgentOpenCode        = "opencode"
	ClientAgentGeminiCLI       = "gemini-cli"
	ClientAgentWorkBuddy       = "workbuddy"
	ClientAgentCodeBuddy       = "codebuddy"
	ClientAgentQoder           = "qoder"
	ClientAgentZCode           = "zcode"
	ClientAgentOpenHands       = "openhands"
	ClientAgentCline           = "cline"
	ClientAgentRooCode         = "roo-code"
	ClientAgentQwenCode        = "qwen-code"
	ClientAgentCursor          = "cursor"
	ClientAgentZed             = "zed"
	ClientAgentGitHubCopilot   = "github-copilot"
	ClientAgentCrush           = "crush"
	ClientAgentGoose           = "goose"
	ClientAgentAmp             = "amp"
	ClientAgentAugment         = "augment"
	ClientAgentKiro            = "kiro"
	ClientAgentAntigravity     = "antigravity"
	ClientAgentDroid           = "droid"
	ClientAgentCommandCode     = "command-code"
	ClientAgentCodeGPT         = "codegpt"
	ClientAgentLetta           = "letta"
	ClientAgentAgentZero       = "agent-zero"
	ClientAgentMiMoCode        = "mimocode"
	ClientAgentJunie           = "junie"
	ClientAgentZencoder        = "zencoder"
	ClientAgentCodeFlicker     = "codeflicker"
	ClientAgentKode            = "kode"
	ClientAgentWindsurf        = "windsurf"
	ClientAgentTrae            = "trae"
	ClientAgentAider           = "aider"
	ClientAgentContinue        = "continue"
	ClientAgentWarp            = "warp"
	ClientAgentCody            = "cody"
	ClientAgentDevin           = "devin"
	ClientAgentManus           = "manus"
	ClientAgentReplit          = "replit"
	ClientAgentPlandex         = "plandex"
	ClientAgentSWEAgent        = "swe-agent"
	ClientAgentGPTMe           = "gptme"
	ClientAgentLovable         = "lovable"
	ClientAgentV0              = "v0"
	ClientAgentBlackbox        = "blackbox"
	ClientAgentPearAI          = "pearai"
	ClientAgentVoid            = "void"
	ClientAgentFreeCode        = "freecode"
	ClientAgentAtomic          = "atomic"
	ClientAgentGrokBuild       = "grok-build"
	ClientAgentMiniMaxCode     = "minimax-code"
	ClientAgentMaka            = "maka"
	ClientAgentExo             = "exo"
	ClientAgentGraff           = "graff"
	ClientAgentMuseCode        = "muse-code"
	ClientAgentMistralVibe     = "mistral-vibe"
	ClientAgentStepCode        = "stepcode"
	ClientAgentMothX           = "mothx"
	ClientAgentPenguin         = "penguin-harness"
	ClientAgentOmO             = "omo"
	ClientAgentReasonix        = "reasonix"
	ClientAgentMorph           = "mister-morph"
	ClientAgentNanobot         = "nanobot"
	ClientAgentAstrBot         = "astrbot"
	ClientAgentShelley         = "shelley"
	ClientAgentOpenHanako      = "openhanako"
	ClientAgentAtomCode        = "atomcode"
	ClientAgentPaimon          = "paimon"
	ClientAgentDevEco          = "deveco-code"
	ClientAgentPaseo           = "paseo"
	ClientAgentT3Code          = "t3-code"
	ClientAgentSnowCLI         = "snow-cli"
	ClientAgentPrimeAgent      = "prime-agent"
	ClientAgentDCode           = "dcode"
	ClientAgentOhMyCPA         = "oh-my-cpa"
	ClientAgentHindsight       = "hindsight"

	// AI desktop / web clients and agent frameworks.
	ClientAgentCherryStudio = "cherry-studio"
	ClientAgentLobeChat     = "lobechat"
	ClientAgentOpenWebUI    = "open-webui"
	ClientAgentChatbox      = "chatbox"
	ClientAgentNextChat     = "nextchat"
	ClientAgentAnythingLLM  = "anythingllm"
	ClientAgentLibreChat    = "librechat"
	ClientAgentSillyTavern  = "sillytavern"
	ClientAgentJan          = "jan"
	ClientAgentMsty         = "msty"
	ClientAgentAlma         = "alma"
	ClientAgentKelivo       = "kelivo"
	ClientAgentRikkaHub     = "rikkahub"
	ClientAgentChatWise     = "chatwise"
	ClientAgentTypingMind   = "typingmind"
	ClientAgentRaycast      = "raycast"
	ClientAgentAionUi       = "aionui"
	ClientAgentDify         = "dify"
	ClientAgentCoze         = "coze"
	ClientAgentFastGPT      = "fastgpt"
	ClientAgentN8n          = "n8n"
	ClientAgentMastra       = "mastra"
	ClientAgentCrewAI       = "crewai"
	ClientAgentPydanticAI   = "pydantic-ai"
	ClientAgentMetaGPT      = "metagpt"
	ClientAgentAgno         = "agno"
	ClientAgentAutoGen      = "autogen"
	ClientAgentSmolagents   = "smolagents"
	ClientAgentDSPy         = "dspy"
	ClientAgentLangflow     = "langflow"
	ClientAgentPortkey      = "portkey"

	// Generic SDKs and HTTP runtimes.
	ClientAgentPythonHTTPX    = "python-httpx"
	ClientAgentPythonReqs     = "python-requests"
	ClientAgentAioHTTP        = "aiohttp"
	ClientAgentOpenAISDK      = "openai-sdk"
	ClientAgentAnthropicSDK   = "anthropic-sdk"
	ClientAgentGoogleGenAISDK = "google-genai-sdk"
	ClientAgentVercelAISDK    = "vercel-ai-sdk"
	ClientAgentLiteLLM        = "litellm"
	ClientAgentLangChain      = "langchain"
	ClientAgentLlamaIndex     = "llamaindex"
	ClientAgentCurl           = "curl"
	ClientAgentUndici         = "undici"
	ClientAgentNodeHTTP       = "node-http"
	ClientAgentGoHTTPClient   = "go-http-client"
	ClientAgentAxios          = "axios"
	ClientAgentOkHTTP         = "okhttp"
	ClientAgentBrowser        = "browser"
)

const maxClientAgentIDLen = 48

var knownAgentIDs = map[string]struct{}{
	ClientAgentHermes:          {},
	ClientAgentKiloCode:        {},
	ClientAgentClaudeCode:      {},
	ClientAgentPi:              {},
	ClientAgentOhMyPi:          {},
	ClientAgentDeepSeekHarness: {},
	ClientAgentStrix:           {},
	ClientAgentOpenClaw:        {},
	ClientAgentCodexCLI:        {},
	ClientAgentKimiCLI:         {},
	ClientAgentOpenCode:        {},
	ClientAgentGeminiCLI:       {},
	ClientAgentWorkBuddy:       {},
	ClientAgentCodeBuddy:       {},
	ClientAgentQoder:           {},
	ClientAgentZCode:           {},
	ClientAgentOpenHands:       {},
	ClientAgentCline:           {},
	ClientAgentRooCode:         {},
	ClientAgentQwenCode:        {},
	ClientAgentCursor:          {},
	ClientAgentZed:             {},
	ClientAgentGitHubCopilot:   {},
	ClientAgentCrush:           {},
	ClientAgentGoose:           {},
	ClientAgentAmp:             {},
	ClientAgentAugment:         {},
	ClientAgentKiro:            {},
	ClientAgentAntigravity:     {},
	ClientAgentDroid:           {},
	ClientAgentCommandCode:     {},
	ClientAgentCodeGPT:         {},
	ClientAgentLetta:           {},
	ClientAgentAgentZero:       {},
	ClientAgentMiMoCode:        {},
	ClientAgentJunie:           {},
	ClientAgentZencoder:        {},
	ClientAgentCodeFlicker:     {},
	ClientAgentKode:            {},
	ClientAgentWindsurf:        {},
	ClientAgentTrae:            {},
	ClientAgentAider:           {},
	ClientAgentContinue:        {},
	ClientAgentWarp:            {},
	ClientAgentCody:            {},
	ClientAgentDevin:           {},
	ClientAgentManus:           {},
	ClientAgentReplit:          {},
	ClientAgentPlandex:         {},
	ClientAgentSWEAgent:        {},
	ClientAgentGPTMe:           {},
	ClientAgentLovable:         {},
	ClientAgentV0:              {},
	ClientAgentBlackbox:        {},
	ClientAgentPearAI:          {},
	ClientAgentVoid:            {},
	ClientAgentFreeCode:        {},
	ClientAgentAtomic:          {},
	ClientAgentGrokBuild:       {},
	ClientAgentMiniMaxCode:     {},
	ClientAgentMaka:            {},
	ClientAgentExo:             {},
	ClientAgentGraff:           {},
	ClientAgentMuseCode:        {},
	ClientAgentMistralVibe:     {},
	ClientAgentStepCode:        {},
	ClientAgentMothX:           {},
	ClientAgentPenguin:         {},
	ClientAgentOmO:             {},
	ClientAgentReasonix:        {},
	ClientAgentMorph:           {},
	ClientAgentNanobot:         {},
	ClientAgentAstrBot:         {},
	ClientAgentShelley:         {},
	ClientAgentOpenHanako:      {},
	ClientAgentAtomCode:        {},
	ClientAgentPaimon:          {},
	ClientAgentDevEco:          {},
	ClientAgentPaseo:           {},
	ClientAgentT3Code:          {},
	ClientAgentSnowCLI:         {},
	ClientAgentPrimeAgent:      {},
	ClientAgentDCode:           {},
	ClientAgentOhMyCPA:         {},
	ClientAgentHindsight:       {},
	ClientAgentCherryStudio:    {},
	ClientAgentLobeChat:        {},
	ClientAgentOpenWebUI:       {},
	ClientAgentChatbox:         {},
	ClientAgentNextChat:        {},
	ClientAgentAnythingLLM:     {},
	ClientAgentLibreChat:       {},
	ClientAgentSillyTavern:     {},
	ClientAgentJan:             {},
	ClientAgentMsty:            {},
	ClientAgentAlma:            {},
	ClientAgentKelivo:          {},
	ClientAgentRikkaHub:        {},
	ClientAgentChatWise:        {},
	ClientAgentTypingMind:      {},
	ClientAgentRaycast:         {},
	ClientAgentAionUi:          {},
	ClientAgentDify:            {},
	ClientAgentCoze:            {},
	ClientAgentFastGPT:         {},
	ClientAgentN8n:             {},
	ClientAgentMastra:          {},
	ClientAgentCrewAI:          {},
	ClientAgentPydanticAI:      {},
	ClientAgentMetaGPT:         {},
	ClientAgentAgno:            {},
	ClientAgentAutoGen:         {},
	ClientAgentSmolagents:      {},
	ClientAgentDSPy:            {},
	ClientAgentLangflow:        {},
	ClientAgentPortkey:         {},
}

var knownSDKIDs = map[string]struct{}{
	ClientAgentPythonHTTPX:    {},
	ClientAgentPythonReqs:     {},
	ClientAgentAioHTTP:        {},
	ClientAgentOpenAISDK:      {},
	ClientAgentAnthropicSDK:   {},
	ClientAgentGoogleGenAISDK: {},
	ClientAgentVercelAISDK:    {},
	ClientAgentLiteLLM:        {},
	ClientAgentLangChain:      {},
	ClientAgentLlamaIndex:     {},
	ClientAgentCurl:           {},
	ClientAgentUndici:         {},
	ClientAgentNodeHTTP:       {},
	ClientAgentGoHTTPClient:   {},
	ClientAgentAxios:          {},
	ClientAgentOkHTTP:         {},
	ClientAgentBrowser:        {},
}

// IsCanonicalClientAgentID reports whether id is a built-in low-cardinality
// agent, client, SDK, or unknown bucket rather than an open-ended fallback token.
func IsCanonicalClientAgentID(id string) bool {
	if id == ClientAgentUnknown {
		return true
	}
	if _, ok := knownAgentIDs[id]; ok {
		return true
	}
	_, ok := knownSDKIDs[id]
	return ok
}

// agentMarkerAliases maps Agent/<name> and AI-Agent/<name> propagation tokens
// (used by agent-detector, GitHub CLI, Databricks SDK, Claude Code, and OpenCode)
// to canonical agent identifiers.
var agentMarkerAliases = map[string]string{
	"hermes":                ClientAgentHermes,
	"hermes-agent":          ClientAgentHermes,
	"hermes_agent":          ClientAgentHermes,
	"hermesagent":           ClientAgentHermes,
	"kilo-code":             ClientAgentKiloCode,
	"kilo_code":             ClientAgentKiloCode,
	"kilo":                  ClientAgentKiloCode,
	"claude-code":           ClientAgentClaudeCode,
	"claude_code":           ClientAgentClaudeCode,
	"cowork":                ClientAgentClaudeCode,
	"pi":                    ClientAgentPi,
	"pi-coding-agent":       ClientAgentPi,
	"pi-desktop":            ClientAgentPi,
	"oh-my-pi":              ClientAgentOhMyPi,
	"oh_my_pi":              ClientAgentOhMyPi,
	"omp":                   ClientAgentOhMyPi,
	"deepseek-harness":      ClientAgentDeepSeekHarness,
	"deepseek_harness":      ClientAgentDeepSeekHarness,
	"dsh":                   ClientAgentDeepSeekHarness,
	"strix":                 ClientAgentStrix,
	"openclaw":              ClientAgentOpenClaw,
	"clawdbot":              ClientAgentOpenClaw,
	"moltbot":               ClientAgentOpenClaw,
	"codex":                 ClientAgentCodexCLI,
	"codex-cli":             ClientAgentCodexCLI,
	"codex_cli":             ClientAgentCodexCLI,
	"codex-desktop":         ClientAgentCodexCLI,
	"codex_desktop":         ClientAgentCodexCLI,
	"codex_chatgpt_desktop": ClientAgentCodexCLI,
	"codex-chatgpt-desktop": ClientAgentCodexCLI,
	"codex_app":             ClientAgentCodexCLI,
	"codex-app":             ClientAgentCodexCLI,
	"codex_vscode":          ClientAgentCodexCLI,
	"codex_vscode_copilot":  ClientAgentCodexCLI,
	"codex_atlas":           ClientAgentCodexCLI,
	"codex_sdk_ts":          ClientAgentCodexCLI,
	"codexapp":              ClientAgentCodexCLI,
	"kimi-cli":              ClientAgentKimiCLI,
	"kimi_cli":              ClientAgentKimiCLI,
	"kimi-code":             ClientAgentKimiCLI,
	"kimicode":              ClientAgentKimiCLI,
	"opencode":              ClientAgentOpenCode,
	"gemini-cli":            ClientAgentGeminiCLI,
	"gemini_cli":            ClientAgentGeminiCLI,
	"workbuddy":             ClientAgentWorkBuddy,
	"workbuddy-ai":          ClientAgentWorkBuddy,
	"codebuddy":             ClientAgentCodeBuddy,
	"qoder":                 ClientAgentQoder,
	"qoder-cli":             ClientAgentQoder,
	"qoder-cn":              ClientAgentQoder,
	"zcode":                 ClientAgentZCode,
	"openhands":             ClientAgentOpenHands,
	"opendevin":             ClientAgentOpenHands,
	"cline":                 ClientAgentCline,
	"cline-cli":             ClientAgentCline,
	"roo-code":              ClientAgentRooCode,
	"roo_code":              ClientAgentRooCode,
	"roocode":               ClientAgentRooCode,
	"qwen-code":             ClientAgentQwenCode,
	"qwen_code":             ClientAgentQwenCode,
	"qwencode":              ClientAgentQwenCode,
	"cursor":                ClientAgentCursor,
	"cursor-cli":            ClientAgentCursor,
	"zed":                   ClientAgentZed,
	"copilot":               ClientAgentGitHubCopilot,
	"copilot-cli":           ClientAgentGitHubCopilot,
	"copilot_cli":           ClientAgentGitHubCopilot,
	"github-copilot":        ClientAgentGitHubCopilot,
	"github_copilot":        ClientAgentGitHubCopilot,
	"crush":                 ClientAgentCrush,
	"charm-crush":           ClientAgentCrush,
	"goose":                 ClientAgentGoose,
	"amp":                   ClientAgentAmp,
	"augment":               ClientAgentAugment,
	"augment-cli":           ClientAgentAugment,
	"auggie":                ClientAgentAugment,
	"kiro":                  ClientAgentKiro,
	"antigravity":           ClientAgentAntigravity,
	"antigravity-cli":       ClientAgentAntigravity,
	"agy":                   ClientAgentAntigravity,
	"droid":                 ClientAgentDroid,
	"factory":               ClientAgentDroid,
	"factory-cli":           ClientAgentDroid,
	"command-code":          ClientAgentCommandCode,
	"commandcode":           ClientAgentCommandCode,
	"codegpt":               ClientAgentCodeGPT,
	"letta":                 ClientAgentLetta,
	"agent-zero":            ClientAgentAgentZero,
	"agent_zero":            ClientAgentAgentZero,
	"mimocode":              ClientAgentMiMoCode,
	"mimo-code":             ClientAgentMiMoCode,
	"junie":                 ClientAgentJunie,
	"zencoder":              ClientAgentZencoder,
	"codeflicker":           ClientAgentCodeFlicker,
	"kode":                  ClientAgentKode,
	"windsurf":              ClientAgentWindsurf,
	"codeium":               ClientAgentWindsurf,
	"trae":                  ClientAgentTrae,
	"traecode":              ClientAgentTrae,
	"trae-code":             ClientAgentTrae,
	"aider":                 ClientAgentAider,
	"continue":              ClientAgentContinue,
	"warp":                  ClientAgentWarp,
	"cody":                  ClientAgentCody,
	"devin":                 ClientAgentDevin,
	"manus":                 ClientAgentManus,
	"replit":                ClientAgentReplit,
	"plandex":               ClientAgentPlandex,
	"swe-agent":             ClientAgentSWEAgent,
	"sweagent":              ClientAgentSWEAgent,
	"mini-swe-agent":        ClientAgentSWEAgent,
	"gptme":                 ClientAgentGPTMe,
	"lovable":               ClientAgentLovable,
	"v0":                    ClientAgentV0,
	"blackbox":              ClientAgentBlackbox,
	"blackbox-ai":           ClientAgentBlackbox,
	"pearai":                ClientAgentPearAI,
	"void":                  ClientAgentVoid,
	"freecode":              ClientAgentFreeCode,
	"atomic":                ClientAgentAtomic,
	"atomic-agent":          ClientAgentAtomic,
	"grok":                  ClientAgentGrokBuild,
	"grok-build":            ClientAgentGrokBuild,
	"grok_build":            ClientAgentGrokBuild,
	"grok-cli":              ClientAgentGrokBuild,
	"grok-shell":            ClientAgentGrokBuild,
	"grok-app":              ClientAgentGrokBuild,
	"minimax-code":          ClientAgentMiniMaxCode,
	"minimax_code":          ClientAgentMiniMaxCode,
	"minimaxcode":           ClientAgentMiniMaxCode,
	"mcode":                 ClientAgentMiniMaxCode,
	"maka":                  ClientAgentMaka,
	"maka-agent":            ClientAgentMaka,
	"apache-maka":           ClientAgentMaka,
	"exo":                   ClientAgentExo,
	"exoharness":            ClientAgentExo,
	"exo-harness":           ClientAgentExo,
	"graff":                 ClientAgentGraff,
	"codegraff":             ClientAgentGraff,
	"muse":                  ClientAgentMuseCode,
	"muse-code":             ClientAgentMuseCode,
	"muse_code":             ClientAgentMuseCode,
	"musecode":              ClientAgentMuseCode,
	"muse-build":            ClientAgentMuseCode,
	"mistral-vibe":          ClientAgentMistralVibe,
	"mistral_vibe":          ClientAgentMistralVibe,
	"stepcode":              ClientAgentStepCode,
	"step-code":             ClientAgentStepCode,
	"step_code":             ClientAgentStepCode,
	"mothx":                 ClientAgentMothX,
	"vibecoding":            ClientAgentMothX,
	"penguin":               ClientAgentPenguin,
	"penguin-harness":       ClientAgentPenguin,
	"penguinharness":        ClientAgentPenguin,
	"omo":                   ClientAgentOmO,
	"omo-ai":                ClientAgentOmO,
	"oh-my-openagent":       ClientAgentOmO,
	"reasonix":              ClientAgentReasonix,
	"reasonix-studio":       ClientAgentReasonix,
	"morph":                 ClientAgentMorph,
	"mistermorph":           ClientAgentMorph,
	"mister-morph":          ClientAgentMorph,
	"nanobot":               ClientAgentNanobot,
	"astrbot":               ClientAgentAstrBot,
	"shelley":               ClientAgentShelley,
	"openhanako":            ClientAgentOpenHanako,
	"hanaagent":             ClientAgentOpenHanako,
	"atomcode":              ClientAgentAtomCode,
	"paimon":                ClientAgentPaimon,
	"deveco-code":           ClientAgentDevEco,
	"paseo":                 ClientAgentPaseo,
	"getpaseo":              ClientAgentPaseo,
	"t3-code":               ClientAgentT3Code,
	"t3code":                ClientAgentT3Code,
	"snow-cli":              ClientAgentSnowCLI,
	"prime-agent":           ClientAgentPrimeAgent,
	"prime_agent":           ClientAgentPrimeAgent,
	"primeagent":            ClientAgentPrimeAgent,
	"dcode":                 ClientAgentDCode,
	"d-code":                ClientAgentDCode,
	"oh-my-cpa":             ClientAgentOhMyCPA,
	"oh_my_cpa":             ClientAgentOhMyCPA,
	"hindsight":             ClientAgentHindsight,
	"alma":                  ClientAgentAlma,
	"raycast":               ClientAgentRaycast,
	"aionui":                ClientAgentAionUi,
}

// unambiguousAgentHeads names product prefixes specific enough to match with or
// without a "/version" suffix (for example "Qoder-Cli", "openclaw", "Vibecoding Client/1.3").
var unambiguousAgentHeads = map[string]string{
	"hermes-agent":          ClientAgentHermes,
	"hermes_agent":          ClientAgentHermes,
	"hermesagent":           ClientAgentHermes,
	"hermes-cli":            ClientAgentHermes,
	"nous-hermes":           ClientAgentHermes,
	"kilo-code":             ClientAgentKiloCode,
	"claude-code":           ClientAgentClaudeCode,
	"pi-coding-agent":       ClientAgentPi,
	"pi-openrouter-plus":    ClientAgentPi,
	"pi-desktop":            ClientAgentPi,
	"oh-my-pi":              ClientAgentOhMyPi,
	"oh_my_pi":              ClientAgentOhMyPi,
	"deepseek-harness":      ClientAgentDeepSeekHarness,
	"deepseek_harness":      ClientAgentDeepSeekHarness,
	"deepseek-harness-sdk":  ClientAgentDeepSeekHarness,
	"strix-cli":             ClientAgentStrix,
	"strix-agent":           ClientAgentStrix,
	"usestrix":              ClientAgentStrix,
	"openclaw":              ClientAgentOpenClaw,
	"openclaw-gateway":      ClientAgentOpenClaw,
	"clawdbot":              ClientAgentOpenClaw,
	"moltbot":               ClientAgentOpenClaw,
	"codex_cli_rs":          ClientAgentCodexCLI,
	"codex_exec":            ClientAgentCodexCLI,
	"codex-tui":             ClientAgentCodexCLI,
	"codex-cli":             ClientAgentCodexCLI,
	"acp-extension-codex":   ClientAgentCodexCLI,
	"codex-desktop":         ClientAgentCodexCLI,
	"codex_desktop":         ClientAgentCodexCLI,
	"codex_chatgpt_desktop": ClientAgentCodexCLI,
	"codex-chatgpt-desktop": ClientAgentCodexCLI,
	"codex_app":             ClientAgentCodexCLI,
	"codex-app":             ClientAgentCodexCLI,
	"codex_vscode":          ClientAgentCodexCLI,
	"codex_vscode_copilot":  ClientAgentCodexCLI,
	"codex_atlas":           ClientAgentCodexCLI,
	"codex_sdk_ts":          ClientAgentCodexCLI,
	"codexapp":              ClientAgentCodexCLI,
	"kimicli":               ClientAgentKimiCLI,
	"kimicodecli":           ClientAgentKimiCLI,
	"kimi-cli":              ClientAgentKimiCLI,
	"kimi-code":             ClientAgentKimiCLI,
	"kimi-code-cli":         ClientAgentKimiCLI,
	"kimi-code-desktop":     ClientAgentKimiCLI,
	"kimicode":              ClientAgentKimiCLI,
	"opencode":              ClientAgentOpenCode,
	"gemini-cli":            ClientAgentGeminiCLI,
	"geminicli":             ClientAgentGeminiCLI,
	"geminicli-tui":         ClientAgentGeminiCLI,
	"cloudcodevscode":       ClientAgentGeminiCLI,
	"workbuddy":             ClientAgentWorkBuddy,
	"workbuddy-ai":          ClientAgentWorkBuddy,
	"codebuddy":             ClientAgentCodeBuddy,
	"codebuddy-cli":         ClientAgentCodeBuddy,
	"tencent-codebuddy":     ClientAgentCodeBuddy,
	"qoder":                 ClientAgentQoder,
	"qoder-cli":             ClientAgentQoder,
	"qodercli":              ClientAgentQoder,
	"qoder-cn":              ClientAgentQoder,
	"qoderclicn":            ClientAgentQoder,
	"zcode":                 ClientAgentZCode,
	"zcode-cli":             ClientAgentZCode,
	"openhands":             ClientAgentOpenHands,
	"openhands-cli":         ClientAgentOpenHands,
	"opendevin":             ClientAgentOpenHands,
	"all-hands":             ClientAgentOpenHands,
	"cline-cli":             ClientAgentCline,
	"roo-code":              ClientAgentRooCode,
	"roocode":               ClientAgentRooCode,
	"qwencode":              ClientAgentQwenCode,
	"qwen-code":             ClientAgentQwenCode,
	"qwen_code":             ClientAgentQwenCode,
	"cursor-cli":            ClientAgentCursor,
	"cursor-agent":          ClientAgentCursor,
	"zed-editor":            ClientAgentZed,
	"githubcopilotchat":     ClientAgentGitHubCopilot,
	"githubcopilot":         ClientAgentGitHubCopilot,
	"github-copilot":        ClientAgentGitHubCopilot,
	"github-copilot-cli":    ClientAgentGitHubCopilot,
	"copilot-cli":           ClientAgentGitHubCopilot,
	"copilot-jetbrains":     ClientAgentGitHubCopilot,
	"charm-crush":           ClientAgentCrush,
	"goose-cli":             ClientAgentGoose,
	"amp-cli":               ClientAgentAmp,
	"ampcode":               ClientAgentAmp,
	"augment-cli":           ClientAgentAugment,
	"augment-code":          ClientAgentAugment,
	"auggie":                ClientAgentAugment,
	"kiro-cli":              ClientAgentKiro,
	"antigravity":           ClientAgentAntigravity,
	"antigravity-cli":       ClientAgentAntigravity,
	"factory-cli":           ClientAgentDroid,
	"factory-droid":         ClientAgentDroid,
	"droid-cli":             ClientAgentDroid,
	"command-code":          ClientAgentCommandCode,
	"commandcode":           ClientAgentCommandCode,
	"codegpt":               ClientAgentCodeGPT,
	"codegpt-cli":           ClientAgentCodeGPT,
	"letta-code":            ClientAgentLetta,
	"letta-cli":             ClientAgentLetta,
	"memgpt":                ClientAgentLetta,
	"agent-zero":            ClientAgentAgentZero,
	"agentzero":             ClientAgentAgentZero,
	"agent_zero":            ClientAgentAgentZero,
	"mimocode":              ClientAgentMiMoCode,
	"mimo-code":             ClientAgentMiMoCode,
	"mimo-coder":            ClientAgentMiMoCode,
	"junie-cli":             ClientAgentJunie,
	"jetbrains-junie":       ClientAgentJunie,
	"zencoder":              ClientAgentZencoder,
	"zencoder-cli":          ClientAgentZencoder,
	"codeflicker":           ClientAgentCodeFlicker,
	"kode-cli":              ClientAgentKode,
	"windsurf":              ClientAgentWindsurf,
	"windsurf-cli":          ClientAgentWindsurf,
	"codeium":               ClientAgentWindsurf,
	"trae-ide":              ClientAgentTrae,
	"trae-cli":              ClientAgentTrae,
	"traecode":              ClientAgentTrae,
	"trae-code":             ClientAgentTrae,
	"aider-chat":            ClientAgentAider,
	"continue-cli":          ClientAgentContinue,
	"continue-dev":          ClientAgentContinue,
	"warp-terminal":         ClientAgentWarp,
	"sourcegraph-cody":      ClientAgentCody,
	"cody-cli":              ClientAgentCody,
	"devin-cli":             ClientAgentDevin,
	"manus-agent":           ClientAgentManus,
	"replit-agent":          ClientAgentReplit,
	"plandex":               ClientAgentPlandex,
	"plandex-cli":           ClientAgentPlandex,
	"swe-agent":             ClientAgentSWEAgent,
	"sweagent":              ClientAgentSWEAgent,
	"mini-swe-agent":        ClientAgentSWEAgent,
	"gptme":                 ClientAgentGPTMe,
	"gpt-engineer":          ClientAgentLovable,
	"vercel-v0":             ClientAgentV0,
	"blackboxai":            ClientAgentBlackbox,
	"blackbox-ai":           ClientAgentBlackbox,
	"blackbox-cli":          ClientAgentBlackbox,
	"pearai":                ClientAgentPearAI,
	"voideditor":            ClientAgentVoid,
	"void-editor":           ClientAgentVoid,
	"freecode":              ClientAgentFreeCode,
	"free-code":             ClientAgentFreeCode,
	"atomic-agent":          ClientAgentAtomic,
	"atomic-cli":            ClientAgentAtomic,
	"grok-shell":            ClientAgentGrokBuild,
	"grok-pager":            ClientAgentGrokBuild,
	"xai-grok-build":        ClientAgentGrokBuild,
	"grok-build":            ClientAgentGrokBuild,
	"grok-cli":              ClientAgentGrokBuild,
	"grok-app":              ClientAgentGrokBuild,
	"minimax-code":          ClientAgentMiniMaxCode,
	"minimaxcode":           ClientAgentMiniMaxCode,
	"minimax-cli":           ClientAgentMiniMaxCode,
	"mcode":                 ClientAgentMiniMaxCode,
	"mcode-cli":             ClientAgentMiniMaxCode,
	"maka-agent":            ClientAgentMaka,
	"apache-maka":           ClientAgentMaka,
	"maka-cli":              ClientAgentMaka,
	"exoharness":            ClientAgentExo,
	"exo-harness":           ClientAgentExo,
	"exo-cli":               ClientAgentExo,
	"codegraff":             ClientAgentGraff,
	"graff-cli":             ClientAgentGraff,
	"muse-build":            ClientAgentMuseCode,
	"muse-code":             ClientAgentMuseCode,
	"musecode":              ClientAgentMuseCode,
	"mistral-vibe":          ClientAgentMistralVibe,
	"vibe-cli":              ClientAgentMistralVibe,
	"stepcode":              ClientAgentStepCode,
	"step-code":             ClientAgentStepCode,
	"mothx":                 ClientAgentMothX,
	"vibecoding":            ClientAgentMothX,
	"penguin-harness":       ClientAgentPenguin,
	"penguinharness":        ClientAgentPenguin,
	"penguin-cli":           ClientAgentPenguin,
	"oh-my-openagent":       ClientAgentOmO,
	"omo-ai":                ClientAgentOmO,
	"reasonix":              ClientAgentReasonix,
	"reasonix-studio":       ClientAgentReasonix,
	"mistermorph":           ClientAgentMorph,
	"mister-morph":          ClientAgentMorph,
	"nanobot":               ClientAgentNanobot,
	"nanobot-ai":            ClientAgentNanobot,
	"astrbot":               ClientAgentAstrBot,
	"openhanako":            ClientAgentOpenHanako,
	"hanaagent":             ClientAgentOpenHanako,
	"atomcode":              ClientAgentAtomCode,
	"deveco-code":           ClientAgentDevEco,
	"deveco-cli":            ClientAgentDevEco,
	"getpaseo":              ClientAgentPaseo,
	"t3code":                ClientAgentT3Code,
	"t3-code":               ClientAgentT3Code,
	"snow-cli":              ClientAgentSnowCLI,
	"snowcli":               ClientAgentSnowCLI,
	"prime-agent":           ClientAgentPrimeAgent,
	"prime_agent":           ClientAgentPrimeAgent,
	"primeagent":            ClientAgentPrimeAgent,
	"dcode":                 ClientAgentDCode,
	"d-code":                ClientAgentDCode,
	"oh-my-cpa":             ClientAgentOhMyCPA,
	"oh_my_cpa":             ClientAgentOhMyCPA,
	"ohmycpa":               ClientAgentOhMyCPA,
	"hindsight":             ClientAgentHindsight,
	"hindsight-api":         ClientAgentHindsight,
	"hindsight-client":      ClientAgentHindsight,
	"hindsight-cli":         ClientAgentHindsight,
	"vectorize-hindsight":   ClientAgentHindsight,
	"cherrystudio":          ClientAgentCherryStudio,
	"cherry-studio":         ClientAgentCherryStudio,
	"lobechat":              ClientAgentLobeChat,
	"lobehub":               ClientAgentLobeChat,
	"open-webui":            ClientAgentOpenWebUI,
	"openwebui":             ClientAgentOpenWebUI,
	"chatbox":               ClientAgentChatbox,
	"chatboxai":             ClientAgentChatbox,
	"chatbox-ai":            ClientAgentChatbox,
	"nextchat":              ClientAgentNextChat,
	"chatgpt-next-web":      ClientAgentNextChat,
	"anythingllm":           ClientAgentAnythingLLM,
	"anything-llm":          ClientAgentAnythingLLM,
	"librechat":             ClientAgentLibreChat,
	"sillytavern":           ClientAgentSillyTavern,
	"jan-ai":                ClientAgentJan,
	"msty":                  ClientAgentMsty,
	"mstystudio":            ClientAgentMsty,
	"alma-app":              ClientAgentAlma,
	"kelivo":                ClientAgentKelivo,
	"rikkahub":              ClientAgentRikkaHub,
	"chatwise":              ClientAgentChatWise,
	"typingmind":            ClientAgentTypingMind,
	"raycast-ai":            ClientAgentRaycast,
	"aionui":                ClientAgentAionUi,
	"dify":                  ClientAgentDify,
	"dify-api":              ClientAgentDify,
	"dify-plugin":           ClientAgentDify,
	"coze":                  ClientAgentCoze,
	"coze-studio":           ClientAgentCoze,
	"fastgpt":               ClientAgentFastGPT,
	"mastra":                ClientAgentMastra,
	"crewai":                ClientAgentCrewAI,
	"pydantic-ai":           ClientAgentPydanticAI,
	"metagpt":               ClientAgentMetaGPT,
	"phidata":               ClientAgentAgno,
	"pyautogen":             ClientAgentAutoGen,
	"smolagents":            ClientAgentSmolagents,
	"dspy":                  ClientAgentDSPy,
	"langflow":              ClientAgentLangflow,
	"portkey":               ClientAgentPortkey,
	"portkey-ai":            ClientAgentPortkey,
}

// versionedAgentHeads names short or common-word agent tokens ("pi", "omp", "dsh",
// "strix", "hermes", "amp", "zed", "cline", "goose", "maka", "exo", "grok") that
// require an explicit "/<version-or-channel>" segment so ordinary words never false-positive.
var versionedAgentHeads = map[string]string{
	"pi":       ClientAgentPi,
	"omp":      ClientAgentOhMyPi,
	"dsh":      ClientAgentDeepSeekHarness,
	"hermes":   ClientAgentHermes,
	"strix":    ClientAgentStrix,
	"codex":    ClientAgentCodexCLI,
	"cursor":   ClientAgentCursor,
	"zed":      ClientAgentZed,
	"cline":    ClientAgentCline,
	"copilot":  ClientAgentGitHubCopilot,
	"crush":    ClientAgentCrush,
	"goose":    ClientAgentGoose,
	"amp":      ClientAgentAmp,
	"augment":  ClientAgentAugment,
	"kiro":     ClientAgentKiro,
	"agy":      ClientAgentAntigravity,
	"droid":    ClientAgentDroid,
	"kode":     ClientAgentKode,
	"junie":    ClientAgentJunie,
	"letta":    ClientAgentLetta,
	"trae":     ClientAgentTrae,
	"aider":    ClientAgentAider,
	"continue": ClientAgentContinue,
	"warp":     ClientAgentWarp,
	"cody":     ClientAgentCody,
	"devin":    ClientAgentDevin,
	"manus":    ClientAgentManus,
	"replit":   ClientAgentReplit,
	"lovable":  ClientAgentLovable,
	"v0":       ClientAgentV0,
	"void":     ClientAgentVoid,
	"atomic":   ClientAgentAtomic,
	"grok":     ClientAgentGrokBuild,
	"maka":     ClientAgentMaka,
	"exo":      ClientAgentExo,
	"graff":    ClientAgentGraff,
	"omo":      ClientAgentOmO,
	"shelley":  ClientAgentShelley,
	"paimon":   ClientAgentPaimon,
	"paseo":    ClientAgentPaseo,
	"raycast":  ClientAgentRaycast,
	"jan":      ClientAgentJan,
	"alma":     ClientAgentAlma,
	"n8n":      ClientAgentN8n,
	"agno":     ClientAgentAgno,
	"autogen":  ClientAgentAutoGen,
}

var knownSDKHeads = map[string]string{
	"anthropic":            ClientAgentAnthropicSDK,
	"asyncanthropic":       ClientAgentAnthropicSDK,
	"anthropic-python":     ClientAgentAnthropicSDK,
	"anthropic-typescript": ClientAgentAnthropicSDK,
	"anthropic-go":         ClientAgentAnthropicSDK,
	"openai":               ClientAgentOpenAISDK,
	"asyncopenai":          ClientAgentOpenAISDK,
	"openai-python":        ClientAgentOpenAISDK,
	"openai-node":          ClientAgentOpenAISDK,
	"openai-go":            ClientAgentOpenAISDK,
	"openai-java":          ClientAgentOpenAISDK,
	"openai-dotnet":        ClientAgentOpenAISDK,
	"google-genai-sdk":     ClientAgentGoogleGenAISDK,
	"google-genai":         ClientAgentGoogleGenAISDK,
	"genai-js":             ClientAgentGoogleGenAISDK,
	"ai-sdk":               ClientAgentVercelAISDK,
	"vercel-ai-sdk":        ClientAgentVercelAISDK,
	"python-httpx":         ClientAgentPythonHTTPX,
	"python-requests":      ClientAgentPythonReqs,
	"aiohttp":              ClientAgentAioHTTP,
	"litellm":              ClientAgentLiteLLM,
	"langchain":            ClientAgentLangChain,
	"langchain-core":       ClientAgentLangChain,
	"langgraph":            ClientAgentLangChain,
	"llamaindex":           ClientAgentLlamaIndex,
	"llama-index":          ClientAgentLlamaIndex,
	"curl":                 ClientAgentCurl,
	"undici":               ClientAgentUndici,
	"node-fetch":           ClientAgentNodeHTTP,
	"node":                 ClientAgentNodeHTTP,
	"go-http-client":       ClientAgentGoHTTPClient,
	"axios":                ClientAgentAxios,
	"okhttp":               ClientAgentOkHTTP,
	"mozilla":              ClientAgentBrowser,
}

// ClientAgentMatch is the normalized caller identity resolved from a request's
// User-Agent and endpoint.
type ClientAgentMatch struct {
	ID string
	// RawPrefix is the minimized User-Agent prefix stored on usage_events.user_agent
	// when a substring drill-down (?ua=...) can narrow to this caller cleanly.
	RawPrefix string
	Category  ClientAgentCategory
}

// PersistedID returns the column value stored on usage_events.client_agent:
// empty when no client signal was present, and the canonical ID otherwise.
func (m ClientAgentMatch) PersistedID() string {
	if m.ID == "" || m.ID == ClientAgentUnknown {
		return ""
	}
	return m.ID
}

// ClassifyClientAgent identifies the calling coding agent, AI client, or SDK
// runtime from a request's User-Agent and endpoint before persistence-time
// truncation discards secondary product tokens or endpoint query parameters.
//
// Matching operates on discrete header tokens and anchored version segments so
// short product names ("pi", "omp", "dsh", "amp", "zed", "cline", "kilo") never
// false-positive inside ordinary words ("optimized", "decline", "compile", "stamp").
func ClassifyClientAgent(userAgent, endpoint string) ClientAgentMatch {
	redacted := redactUserAgentIfNeeded(userAgent)
	minimized := minimizedFromRedacted(redacted)

	var epPath, epQuery string
	epParsed := false
	ensureEndpoint := func() {
		if !epParsed {
			epPath, epQuery = splitEndpointPathAndQuery(endpoint)
			epParsed = true
		}
	}

	if redacted != "" {
		// 1. Explicit Agent/<name> and AI-Agent/<name> propagation markers.
		for pos := 0; ; {
			token, next, ok := nextUAToken(redacted, pos)
			if !ok {
				break
			}
			pos = next
			head, tail, hasSlash := strings.Cut(token, "/")
			if !hasSlash || (!equalASCIIFold(head, "agent") && !equalASCIIFold(head, "ai-agent")) {
				continue
			}
			subHead, _, _ := strings.Cut(tail, "/")
			if canonical, ok := lookupLower(agentMarkerAliases, subHead); ok {
				return agentMatch(canonical, minimized, token[:len(head)+1+len(subHead)])
			}
		}

		// 2. Leading comment-style agent signatures ("pi (darwin; arm64)", "omp (cli)").
		switch {
		case hasPrefixASCIIFold(redacted, "pi ("):
			return agentMatch(ClientAgentPi, minimized, "pi")
		case hasPrefixASCIIFold(redacted, "omp ("):
			return agentMatch(ClientAgentOhMyPi, minimized, "omp")
		}

		// 3. Native CLI, IDE, desktop, and autonomous agent tokens.
		prevHead := ""
		for pos := 0; ; {
			token, next, ok := nextUAToken(redacted, pos)
			if !ok {
				break
			}
			pos = next
			head, tail, hasSlash := strings.Cut(token, "/")

			if equalASCIIFold(prevHead, "hermes") && equalASCIIFold(head, "agent") {
				return agentMatch(ClientAgentHermes, minimized, "")
			}
			if equalASCIIFold(prevHead, "codex") && equalASCIIFold(head, "desktop") {
				return agentMatch(ClientAgentCodexCLI, minimized, prevHead)
			}

			switch {
			case equalASCIIFold(head, "claude-cli"):
				// Qwen Code disguises third-party /v1/messages calls with a 0.x major version;
				// official Claude Code uses 2.x (and 1.x historically).
				if hasSlash && strings.HasPrefix(tail, "0.") {
					ensureEndpoint()
					if hasEndpointSuffix(epPath, "/v1/messages") {
						return agentMatch(ClientAgentQwenCode, minimized, "claude-cli/0.")
					}
				}
				if hasSlash && strings.HasPrefix(tail, "2.") {
					return agentMatch(ClientAgentClaudeCode, minimized, "claude-cli/2.")
				}
				return agentMatch(ClientAgentClaudeCode, minimized, head)

			case equalASCIIFold(head, "codex_cli_rs"):
				// Hermes Agent identifies itself as "codex_cli_rs/0.0.0 (Hermes Agent)" on
				// custom/proxied Codex Responses endpoints instead of "HermesAgent/<ver>".
				if hasHermesAgentMarker(redacted[pos:]) {
					return agentMatch(ClientAgentHermes, minimized, "")
				}
				return agentMatch(ClientAgentCodexCLI, minimized, head)

			case hasPrefixASCIIFold(head, "geminicli-"):
				return agentMatch(ClientAgentGeminiCLI, minimized, head)

			case hasPrefixASCIIFold(head, "agy-"):
				return agentMatch(ClientAgentAntigravity, minimized, head)

			case hasSlash && equalASCIIFold(head, "kilo"):
				if startsWithVersionToken(tail) {
					return agentMatch(ClientAgentKiloCode, minimized, head)
				}
				ensureEndpoint()
				if hasEndpointSuffix(epPath, "/v1/messages") {
					return agentMatch(ClientAgentKiloCode, minimized, head)
				}

			case hasSlash && equalASCIIFold(head, "git") && equalASCIIFold(tail, "strix"):
				return agentMatch(ClientAgentStrix, minimized, "git/strix")

			case hasPrefixASCIIFold(head, "n8n_"):
				return agentMatch(ClientAgentN8n, minimized, head)
			}

			if canonical, ok := lookupLower(unambiguousAgentHeads, head); ok {
				return agentMatch(canonical, minimized, head)
			}
			if hasSlash && startsWithVersionToken(tail) {
				if canonical, ok := lookupLower(versionedAgentHeads, head); ok {
					return agentMatch(canonical, minimized, head)
				}
			}
			prevHead = head
		}
	}

	// 4. Endpoint query disambiguation: Codex CLI polls /v1/models?client_version=...
	if endpoint != "" {
		ensureEndpoint()
		if hasEndpointSuffix(epPath, "/v1/models") && hasQueryKey(epQuery, "client_version") {
			return ClientAgentMatch{
				ID:       ClientAgentCodexCLI,
				Category: ClientAgentCategoryAgent,
			}
		}
	}

	// 5. Absent or fully redacted User-Agent.
	if minimized == "" {
		return ClientAgentMatch{
			ID:       ClientAgentUnknown,
			Category: ClientAgentCategoryUnknown,
		}
	}

	// 6. Generic SDKs, HTTP libraries, and browsers.
	if hasPrefixASCIIFold(minimized, "@anthropic-ai/sdk") {
		return sdkMatch(ClientAgentAnthropicSDK, minimized, "@anthropic-ai/sdk")
	}
	firstHead, _, _ := strings.Cut(minimized, "/")
	if canonical, ok := lookupLower(knownSDKHeads, firstHead); ok {
		if canonical == ClientAgentBrowser {
			return sdkMatch(ClientAgentBrowser, minimized, "Mozilla/")
		}
		return sdkMatch(canonical, minimized, firstHead)
	}

	slug := NormalizeClientAgentID(firstHead)
	if slug == "" || slug == ClientAgentUnknown || slug == ClientAgentOther {
		return ClientAgentMatch{
			ID:       ClientAgentUnknown,
			Category: ClientAgentCategoryUnknown,
		}
	}
	// Bare unversioned words matching a guarded agent ID (e.g. "amp", "void", "pi")
	// or a guarded versioned alias (e.g. "codex", "omp", "dsh") failed the
	// versioned agent gate above and must not re-enter through the SDK fallback.
	if _, guarded := knownAgentIDs[slug]; guarded {
		return ClientAgentMatch{
			ID:       ClientAgentUnknown,
			Category: ClientAgentCategoryUnknown,
		}
	}
	if _, guardedAlias := versionedAgentHeads[slug]; guardedAlias {
		return ClientAgentMatch{
			ID:       ClientAgentUnknown,
			Category: ClientAgentCategoryUnknown,
		}
	}
	return sdkMatch(slug, minimized, firstHead)
}

// PersistedClientAttribution resolves the persisted (client_agent, client_prefix)
// columns stored on usage_events.
//
// When storedID is already non-empty (for example, pre-classified by DecodeEvent
// before UserAgent minimization and Endpoint query stripping), it normalizes
// storedID and storedPrefix without re-running User-Agent classification. When
// storedID is empty, it classifies (rawUserAgent, rawEndpoint) once.
func PersistedClientAttribution(storedID, storedPrefix, rawUserAgent, rawEndpoint string) (string, string) {
	if storedID != "" {
		if storedID == ClientAgentUnknown {
			return ClientAgentUnknown, ""
		}
		var normalized string
		if isCleanClientAgentSlug(storedID) {
			normalized = storedID
		} else {
			normalized = NormalizeClientAgentID(storedID)
		}
		if normalized == "" || normalized == ClientAgentUnknown {
			return ClientAgentUnknown, ""
		}
		return normalized, sanitizeClientPrefix(storedPrefix)
	}
	match := ClassifyClientAgent(rawUserAgent, rawEndpoint)
	if id := match.PersistedID(); id != "" {
		return id, match.RawPrefix
	}
	return ClientAgentUnknown, ""
}

// ClientAgentFromPersisted projects a persisted usage_events.client_agent value
// for read DTOs without running User-Agent classification, mapping empty and
// "unknown" values to "" so wire payloads omit unidentified callers.
func ClientAgentFromPersisted(storedID string) string {
	if storedID == "" || storedID == ClientAgentUnknown {
		return ""
	}
	return storedID
}

// ResolveHistoricalClientAttribution resolves legacy rows during database
// migration backfill when client_agent or client_prefix has not been persisted
// yet. Runtime read paths must use ClientAgentFromPersisted instead.
func ResolveHistoricalClientAttribution(storedID, userAgent, endpoint string) ClientAgentMatch {
	if storedID == ClientAgentUnknown {
		return ClientAgentMatch{
			ID:       ClientAgentUnknown,
			Category: ClientAgentCategoryUnknown,
		}
	}
	normalized := ""
	if storedID != "" {
		if isCleanClientAgentSlug(storedID) {
			normalized = storedID
		} else {
			normalized = NormalizeClientAgentID(storedID)
		}
	}
	if normalized == "" || normalized == ClientAgentUnknown {
		if equalASCIIFold(trimASCIIWhitespace(userAgent), "codex") {
			// Historical 066 rows stored minimized user_agent = "Codex" from Codex Desktop
			// before client_agent existed; restore Codex attribution without weakening live guards.
			minimized := minimizedFromRedacted(redactUserAgentIfNeeded(userAgent))
			return agentMatch(ClientAgentCodexCLI, minimized, "codex")
		}
		return ClassifyClientAgent(userAgent, endpoint)
	}
	category := ClientAgentCategoryForID(normalized)
	if userAgent == "" {
		return ClientAgentMatch{
			ID:       normalized,
			Category: category,
		}
	}
	live := ClassifyClientAgent(userAgent, endpoint)
	rawPrefix := ""
	if live.ID == normalized || (live.ID == ClientAgentCodexCLI && isLegacyCodexAlias(normalized)) {
		rawPrefix = live.RawPrefix
	} else if normalized == ClientAgentQwenCode {
		minimized := minimizedFromRedacted(redactUserAgentIfNeeded(userAgent))
		rawPrefix = rawPrefixFromMinimized(minimized, "claude-cli/0.")
	} else if (normalized == ClientAgentCodexCLI || isLegacyCodexAlias(normalized)) && equalASCIIFold(trimASCIIWhitespace(userAgent), "codex") {
		minimized := minimizedFromRedacted(redactUserAgentIfNeeded(userAgent))
		rawPrefix = rawPrefixFromMinimized(minimized, "codex")
	}
	return ClientAgentMatch{
		ID:        normalized,
		RawPrefix: rawPrefix,
		Category:  category,
	}
}

func isLegacyCodexAlias(id string) bool {
	switch id {
	case "codex",
		"codex-desktop",
		"codex_desktop",
		"codex_chatgpt_desktop",
		"codex-chatgpt-desktop",
		"codex_app",
		"codex-app",
		"codex_vscode",
		"codex_vscode_copilot",
		"codex_atlas",
		"codex_sdk_ts",
		"codexapp":
		return true
	default:
		return false
	}
}

func sanitizeClientPrefix(raw string) string {
	redacted := redactUserAgentIfNeeded(raw)
	if redacted == "" || strings.Contains(redacted, security.RedactedValue) {
		return ""
	}
	return minimizedFromRedacted(redacted)
}

// ClientAgentCategoryForID returns the category of a normalized client agent ID.
func ClientAgentCategoryForID(id string) ClientAgentCategory {
	switch id {
	case "", ClientAgentUnknown:
		return ClientAgentCategoryUnknown
	default:
		if _, ok := knownAgentIDs[id]; ok {
			return ClientAgentCategoryAgent
		}
		return ClientAgentCategorySDK
	}
}

// NormalizeClientAgentID sanitizes a candidate client identifier into a bounded
// lowercase ASCII slug ([a-z0-9._-]), returning "" when no safe letter remains.
func NormalizeClientAgentID(raw string) string {
	trimmed := redactUserAgentIfNeeded(raw)
	if trimmed == "" || trimmed == security.RedactedValue {
		return ""
	}
	if isCleanClientAgentSlug(trimmed) {
		return trimmed
	}
	var buf [maxClientAgentIDLen]byte
	n := 0
	hasLetter := false
	lastSep := true
	for i := 0; i < len(trimmed) && n < maxClientAgentIDLen; i++ {
		ch := trimmed[i]
		switch {
		case ch >= 'A' && ch <= 'Z':
			buf[n] = ch + ('a' - 'A')
			n++
			hasLetter = true
			lastSep = false
		case ch >= 'a' && ch <= 'z':
			buf[n] = ch
			n++
			hasLetter = true
			lastSep = false
		case ch >= '0' && ch <= '9':
			buf[n] = ch
			n++
			lastSep = false
		case ch == '-' || ch == '_' || ch == '.':
			if !lastSep {
				buf[n] = ch
				n++
				lastSep = true
			}
		}
	}
	for n > 0 && (buf[n-1] == '-' || buf[n-1] == '_' || buf[n-1] == '.') {
		n--
	}
	if !hasLetter || n == 0 {
		return ""
	}
	if isReservedClientSlugBytes(buf[:n]) {
		return ""
	}
	return string(buf[:n])
}

func isCleanClientAgentSlug(s string) bool {
	if s == "" || len(s) > maxClientAgentIDLen {
		return false
	}
	if IsCanonicalClientAgentID(s) {
		return true
	}
	if needsRedaction(s) {
		return false
	}
	hasLetter := false
	lastSep := true
	for i := 0; i < len(s); i++ {
		ch := s[i]
		switch {
		case ch >= 'a' && ch <= 'z':
			hasLetter = true
			lastSep = false
		case ch >= '0' && ch <= '9':
			lastSep = false
		case ch == '-' || ch == '_' || ch == '.':
			if lastSep {
				return false
			}
			lastSep = true
		default:
			return false
		}
	}
	if !hasLetter || lastSep || isReservedClientSlug(s) {
		return false
	}
	return true
}

func isReservedClientSlug(s string) bool {
	switch s {
	case "", "redacted", "bearer", "basic", "authorization", "token", "apikey", "api-key", "api_key":
		return true
	default:
		return false
	}
}

func isReservedClientSlugBytes(b []byte) bool {
	switch string(b) {
	case "", "redacted", "bearer", "basic", "authorization", "token", "apikey", "api-key", "api_key":
		return true
	default:
		return false
	}
}

func redactUserAgentIfNeeded(value string) string {
	if value == "" {
		return ""
	}
	if needsRedaction(value) {
		return strings.TrimSpace(security.RedactText(value))
	}
	return trimASCIIWhitespace(value)
}

// needsRedaction reports whether value could contain control characters, URL
// userinfo/queries, header delimiters, or bare credential prefixes handled by
// security.RedactText. Clean printable ASCII User-Agents skip regexp scanning.
func needsRedaction(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < 0x20 && c != '\t' && c != '\n' && c != '\r') || c >= 0x7f || c == ':' || c == '=' {
			return true
		}
		switch c | 0x20 {
		case 'b':
			if i+6 <= len(s) && equalASCIIFold(s[i:i+6], "bearer") {
				return true
			}
		case 's':
			if i+3 <= len(s) && s[i+1] == 'k' && s[i+2] == '-' {
				return true
			}
		case 'p':
			if i+3 <= len(s) && s[i+1] == 'k' && s[i+2] == '-' {
				return true
			}
			if i+4 <= len(s) && s[i+1] == 'a' && s[i+2] == 't' && (s[i+3] == '-' || s[i+3] == '_') {
				return true
			}
		case 'g':
			if i+4 <= len(s) && (s[i+1]|0x20) == 'h' && s[i+3] == '_' {
				switch s[i+2] | 0x20 {
				case 'p', 'o', 'u', 's', 'r':
					return true
				}
			}
		case 'x':
			if i+3 <= len(s) && (s[i+1]|0x20) == 'o' && (s[i+2]|0x20) == 'x' {
				return true
			}
		}
	}
	return false
}

func trimASCIIWhitespace(s string) string {
	start := 0
	for start < len(s) && isASCIIWhitespace(s[start]) {
		start++
	}
	end := len(s)
	for end > start && isASCIIWhitespace(s[end-1]) {
		end--
	}
	return s[start:end]
}

func isASCIIWhitespace(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\r', '\v', '\f':
		return true
	default:
		return false
	}
}

// minimizedFromRedacted mirrors security.MinimizeUserAgent over an already
// redacted and trimmed string without heap allocations.
func minimizedFromRedacted(redacted string) string {
	if redacted == "" {
		return ""
	}
	first := redacted
	for i := 0; i < len(redacted); {
		c := redacted[i]
		if c < utf8.RuneSelf {
			if isASCIIWhitespace(c) {
				first = redacted[:i]
				break
			}
			i++
			continue
		}
		r, width := utf8.DecodeRuneInString(redacted[i:])
		if isUnicodeWhitespace(r) {
			first = redacted[:i]
			break
		}
		i += width
	}
	first = truncateRunesZeroAlloc(first, 128)
	if first == "" || first == security.RedactedValue {
		return ""
	}
	return first
}

func isUnicodeWhitespace(r rune) bool {
	switch r {
	case '\u0085', '\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000':
		return true
	default:
		return r >= '\u2000' && r <= '\u200A'
	}
}

func truncateRunesZeroAlloc(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	count := 0
	for idx := range s {
		if count == limit {
			return s[:idx]
		}
		count++
	}
	return s
}

func agentMatch(id, minimized, candidatePrefix string) ClientAgentMatch {
	return ClientAgentMatch{
		ID:        id,
		RawPrefix: rawPrefixFromMinimized(minimized, candidatePrefix),
		Category:  ClientAgentCategoryAgent,
	}
}

func sdkMatch(id, minimized, candidatePrefix string) ClientAgentMatch {
	return ClientAgentMatch{
		ID:        id,
		RawPrefix: rawPrefixFromMinimized(minimized, candidatePrefix),
		Category:  ClientAgentCategorySDK,
	}
}

// rawPrefixFromMinimized emits a drill-down UA prefix only when the persisted
// minimized user_agent token actually starts with that prefix.
func rawPrefixFromMinimized(minimized, candidate string) string {
	if minimized == "" || candidate == "" {
		return ""
	}
	if len(minimized) >= len(candidate) && equalASCIIFold(minimized[:len(candidate)], candidate) {
		return minimized[:len(candidate)]
	}
	return ""
}

func hasHermesAgentMarker(rest string) bool {
	prevHead := ""
	for pos := 0; ; {
		token, next, ok := nextUAToken(rest, pos)
		if !ok {
			return false
		}
		pos = next
		head, _, _ := strings.Cut(token, "/")
		if equalASCIIFold(prevHead, "hermes") && equalASCIIFold(head, "agent") {
			return true
		}
		prevHead = head
	}
}

func nextUAToken(ua string, pos int) (string, int, bool) {
	n := len(ua)
	for pos < n && isUADelimiter(ua[pos]) {
		pos++
	}
	if pos >= n {
		return "", n, false
	}
	start := pos
	for pos < n && !isUADelimiter(ua[pos]) {
		pos++
	}
	return ua[start:pos], pos, true
}

func isUADelimiter(c byte) bool {
	switch c {
	case ' ', '\t', '\r', '\n', '(', ')', ';', ',', '[', ']':
		return true
	default:
		return false
	}
}

func lookupLower(m map[string]string, s string) (string, bool) {
	if !hasASCIIUpper(s) {
		v, ok := m[s]
		return v, ok
	}
	if len(s) > 64 {
		return "", false
	}
	var buf [64]byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		buf[i] = c
	}
	v, ok := m[string(buf[:len(s)])]
	return v, ok
}

func hasASCIIUpper(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 'A' && s[i] <= 'Z' {
			return true
		}
	}
	return false
}

func equalASCIIFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		ca, cb := a[i], b[i]
		if ca == cb {
			continue
		}
		if ca >= 'A' && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if cb >= 'A' && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

func hasPrefixASCIIFold(s, prefix string) bool {
	return len(s) >= len(prefix) && equalASCIIFold(s[:len(prefix)], prefix)
}

func startsWithDigit(s string) bool {
	return len(s) > 0 && s[0] >= '0' && s[0] <= '9'
}

// startsWithVersionToken accepts numeric versions ("1.5.0") and channel-prefixed
// versions ("latest/1.0", "v1.2.0", "canary").
func startsWithVersionToken(s string) bool {
	if s == "" {
		return false
	}
	if startsWithDigit(s) {
		return true
	}
	if len(s) > 1 && (s[0] == 'v' || s[0] == 'V') && startsWithDigit(s[1:]) {
		return true
	}
	head, _, _ := strings.Cut(s, "/")
	switch {
	case equalASCIIFold(head, "latest"),
		equalASCIIFold(head, "canary"),
		equalASCIIFold(head, "nightly"),
		equalASCIIFold(head, "beta"),
		equalASCIIFold(head, "alpha"),
		equalASCIIFold(head, "dev"),
		equalASCIIFold(head, "preview"),
		equalASCIIFold(head, "rc"):
		return true
	default:
		return false
	}
}

func splitEndpointPathAndQuery(endpoint string) (string, string) {
	raw := trimASCIIWhitespace(endpoint)
	if raw == "" {
		return "", ""
	}
	// Strip CPA's HTTP method prefix ("POST /v1/messages", "GET /v1/models?client_version=0.47").
	if idx := strings.IndexAny(raw, " \t"); idx > 0 {
		method := raw[:idx]
		if isHTTPMethodASCII(method) {
			raw = trimASCIIWhitespace(raw[idx+1:])
		}
	}
	if hash := strings.IndexByte(raw, '#'); hash >= 0 {
		raw = raw[:hash]
	}
	if hasPrefixASCIIFold(raw, "http://") || hasPrefixASCIIFold(raw, "https://") {
		if parsed, err := url.Parse(raw); err == nil {
			return trimTrailingSlashes(parsed.Path), parsed.RawQuery
		}
	}
	if strings.HasPrefix(raw, "//") {
		if parsed, err := url.Parse("https:" + raw); err == nil {
			return trimTrailingSlashes(parsed.Path), parsed.RawQuery
		}
	}
	pathPart, queryPart, _ := strings.Cut(raw, "?")
	return trimTrailingSlashes(pathPart), queryPart
}

func isHTTPMethodASCII(method string) bool {
	switch {
	case equalASCIIFold(method, "GET"),
		equalASCIIFold(method, "POST"),
		equalASCIIFold(method, "PUT"),
		equalASCIIFold(method, "PATCH"),
		equalASCIIFold(method, "DELETE"),
		equalASCIIFold(method, "HEAD"),
		equalASCIIFold(method, "OPTIONS"):
		return true
	default:
		return false
	}
}

func trimTrailingSlashes(s string) string {
	end := len(s)
	for end > 0 && s[end-1] == '/' {
		end--
	}
	return s[:end]
}

func hasEndpointSuffix(path, suffix string) bool {
	if path == "" || suffix == "" || len(path) < len(suffix) {
		return false
	}
	return equalASCIIFold(path[len(path)-len(suffix):], suffix)
}

func hasQueryKey(rawQuery, key string) bool {
	if rawQuery == "" || key == "" {
		return false
	}
	for rest := rawQuery; rest != ""; {
		var pair string
		pair, rest, _ = strings.Cut(rest, "&")
		k, v, ok := strings.Cut(pair, "=")
		if ok && equalASCIIFold(trimASCIIWhitespace(k), key) && trimASCIIWhitespace(v) != "" {
			return true
		}
	}
	return false
}
