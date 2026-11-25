package usage

import (
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

func TestClassifyClientAgent(t *testing.T) {
	cases := []struct {
		name       string
		ua         string
		endpoint   string
		wantID     string
		wantCat    ClientAgentCategory
		wantPrefix string
	}{
		{
			name: "hermes agent real gateway identity",
			ua:   "hermes-agent/0.8.4 (cli; linux)", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentHermes, wantCat: ClientAgentCategoryAgent, wantPrefix: "hermes-agent",
		},
		{
			name: "hermes agent camelcase attribution user agent",
			ua:   "HermesAgent/0.9.2", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentHermes, wantCat: ClientAgentCategoryAgent, wantPrefix: "HermesAgent",
		},
		{
			name: "hermes agent custom codex endpoint compatibility user agent",
			ua:   "codex_cli_rs/0.0.0 (Hermes Agent)", endpoint: "POST /v1/responses",
			wantID: ClientAgentHermes, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "hermes agent parenthetical comment after sdk user agent",
			ua:   "OpenAI/Python 1.55.0 (Hermes Agent)", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentHermes, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "deepseek harness cli and mandatory attribution url",
			ua:   "deepseek-harness/0.2.1-rc.3 (+https://github.com/deepseek-ai/deepseek-harness)", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentDeepSeekHarness, wantCat: ClientAgentCategoryAgent, wantPrefix: "deepseek-harness",
		},
		{
			name: "deepseek harness dsh short binary",
			ua:   "dsh/0.2.1", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentDeepSeekHarness, wantCat: ClientAgentCategoryAgent, wantPrefix: "dsh",
		},
		{
			name: "grok build shell wire user agent",
			ua:   "grok-shell/0.2.106 (linux; x86_64)", endpoint: "POST /v1/responses",
			wantID: ClientAgentGrokBuild, wantCat: ClientAgentCategoryAgent, wantPrefix: "grok-shell",
		},
		{
			name: "grok build media wire user agent",
			ua:   "xai-grok-build/0.2.106", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentGrokBuild, wantCat: ClientAgentCategoryAgent, wantPrefix: "xai-grok-build",
		},
		{
			name: "minimax code desktop and mcode cli",
			ua:   "MiniMaxCode/0.6.8", endpoint: "POST /v1/messages",
			wantID: ClientAgentMiniMaxCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "MiniMaxCode",
		},
		{
			name: "minimax mcode binary prefix",
			ua:   "mcode/0.4.12", endpoint: "POST /v1/messages",
			wantID: ClientAgentMiniMaxCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "mcode",
		},
		{
			name: "apache maka electron renderer user agent",
			ua:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Maka/0.1.11 Chrome/150.0.0.0 Electron/43.2.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentMaka, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "apache maka direct cli",
			ua:   "Maka/0.2.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentMaka, wantCat: ClientAgentCategoryAgent, wantPrefix: "Maka",
		},
		{
			name: "exo harness cli",
			ua:   "exo/0.1.0", endpoint: "POST /v1/responses",
			wantID: ClientAgentExo, wantCat: ClientAgentCategoryAgent, wantPrefix: "exo",
		},
		{
			name: "mini swe agent",
			ua:   "mini-swe-agent/1.12.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentSWEAgent, wantCat: ClientAgentCategoryAgent, wantPrefix: "mini-swe-agent",
		},
		{
			name: "muse code build harness",
			ua:   "muse-build/0.4.1", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentMuseCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "muse-build",
		},
		{
			name: "mistral vibe cli",
			ua:   "mistral-vibe/1.1.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentMistralVibe, wantCat: ClientAgentCategoryAgent, wantPrefix: "mistral-vibe",
		},
		{
			name: "stepcode cli",
			ua:   "stepcode/0.3.2", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentStepCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "stepcode",
		},
		{
			name: "mothx legacy vibecoding wire user agent",
			ua:   "Vibecoding Client/1.3.104", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentMothX, wantCat: ClientAgentCategoryAgent, wantPrefix: "Vibecoding",
		},
		{
			name: "omo oh-my-openagent fork",
			ua:   "omo/0.9.3", endpoint: "POST /v1/messages",
			wantID: ClientAgentOmO, wantCat: ClientAgentCategoryAgent, wantPrefix: "omo",
		},
		{
			name: "github copilot cli short prefix",
			ua:   "copilot/1.0.4", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentGitHubCopilot, wantCat: ClientAgentCategoryAgent, wantPrefix: "copilot",
		},
		{
			name: "antigravity cli agy short prefix",
			ua:   "agy/1.2.16", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentAntigravity, wantCat: ClientAgentCategoryAgent, wantPrefix: "agy",
		},
		{
			name: "antigravity production verification prefix",
			ua:   "agy-production-verification/1.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentAntigravity, wantCat: ClientAgentCategoryAgent, wantPrefix: "agy-production-verification",
		},
		{
			name: "antigravity cli google genai sdk arm64 build",
			ua:   "google-genai-sdk/1.79.1 gl-go/go1.28-20261102-RC01 cl/1012564305 +298f53e483 X:fieldtrack,boringcrypto,nogolistexportnewformat", endpoint: "POST /v1beta/models/*action",
			wantID: ClientAgentAntigravity, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "antigravity cli google genai sdk x64 simd build",
			ua:   "google-genai-sdk/1.76.0 gl-go/go1.28-20261015-RC02 cl/1000353293 +18a2e1f59d X:fieldtrack,boringcrypto,simd,nogolistexportnewformat", endpoint: "POST /v1beta/models/gemini-4-hydrogen:streamGenerateContent?alt=sse",
			wantID: ClientAgentAntigravity, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "explicit agent takes precedence over google genai internal go toolchain",
			ua:   "google-genai-sdk/1.79.1 gl-go/go1.28-20261102-RC01 cl/1012564305 GeminiCLI/0.66.0", endpoint: "POST /v1beta/models/*action",
			wantID: ClientAgentGeminiCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "oh my cpa console and agent traffic",
			ua:   "Oh-My-CPA/0.4.5", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentOhMyCPA, wantCat: ClientAgentCategoryAgent, wantPrefix: "Oh-My-CPA",
		},
		{
			name: "hindsight memory extraction traffic",
			ua:   "hindsight/1.2.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentHindsight, wantCat: ClientAgentCategoryAgent, wantPrefix: "hindsight",
		},
		{
			name: "alma desktop harness",
			ua:   "Alma/0.8.2", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentAlma, wantCat: ClientAgentCategoryAgent, wantPrefix: "Alma",
		},
		{
			name: "strix autonomous security agent",
			ua:   "strix/0.5.2", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentStrix, wantCat: ClientAgentCategoryAgent, wantPrefix: "strix",
		},
		{
			name: "openclaw release and gateway user agents",
			ua:   "openclaw/2026.3.22", endpoint: "POST /v1/responses",
			wantID: ClientAgentOpenClaw, wantCat: ClientAgentCategoryAgent, wantPrefix: "openclaw",
		},
		{
			name: "openclaw legacy moltbot alias",
			ua:   "moltbot/1.2.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentOpenClaw, wantCat: ClientAgentCategoryAgent, wantPrefix: "moltbot",
		},
		{
			name: "workbuddy desktop and cli",
			ua:   "WorkBuddy/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentWorkBuddy, wantCat: ClientAgentCategoryAgent, wantPrefix: "WorkBuddy",
		},
		{
			name: "codebuddy cli",
			ua:   "CodeBuddy/2.168.2", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentCodeBuddy, wantCat: ClientAgentCategoryAgent, wantPrefix: "CodeBuddy",
		},
		{
			name: "qoder cli bare and versioned",
			ua:   "Qoder-Cli", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentQoder, wantCat: ClientAgentCategoryAgent, wantPrefix: "Qoder-Cli",
		},
		{
			name: "zcode client",
			ua:   "ZCode/0.3.1", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentZCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "ZCode",
		},
		{
			name: "kimi cli real wire fingerprint",
			ua:   "KimiCLI/1.5", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentKimiCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "KimiCLI",
		},
		{
			name: "kimi code desktop wire fingerprint",
			ua:   "kimi-code-desktop/1.2.1", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentKimiCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "kimi-code-desktop",
		},
		{
			name: "oh my pi omp distinct from pi",
			ua:   "omp/1.4.0", endpoint: "POST /v1/messages",
			wantID: ClientAgentOhMyPi, wantCat: ClientAgentCategoryAgent, wantPrefix: "omp",
		},
		{
			name: "oh-my-pi full prefix",
			ua:   "oh-my-pi/1.4.0", endpoint: "POST /v1/messages",
			wantID: ClientAgentOhMyPi, wantCat: ClientAgentCategoryAgent, wantPrefix: "oh-my-pi",
		},
		{
			name: "pi short prefix and comment signature",
			ua:   "pi/1.5.0", endpoint: "POST /v1/messages",
			wantID: ClientAgentPi, wantCat: ClientAgentCategoryAgent, wantPrefix: "pi",
		},
		{
			name: "pi coding agent secondary token",
			ua:   "undici pi-coding-agent/1.5.0", endpoint: "POST /v1/messages",
			wantID: ClientAgentPi, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "claude code 2.x on messages",
			ua:   "claude-cli/2.1.14 (external, cli)", endpoint: "POST /v1/messages",
			wantID: ClientAgentClaudeCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "claude-cli/2.",
		},
		{
			name: "claude code explicit prefix",
			ua:   "claude-code/1.0.3", endpoint: "POST /v1/messages",
			wantID: ClientAgentClaudeCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "claude-code",
		},
		{
			name: "agent-detector AI-Agent propagation token",
			ua:   "example-cli/1.2.3 AI-Agent/amp", endpoint: "POST /v1/messages",
			wantID: ClientAgentAmp, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "claude code wrapper token",
			ua:   "node/22.11.0 Agent/claude-code/2.0", endpoint: "POST /v1/messages",
			wantID: ClientAgentClaudeCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "qwen code disguised as claude-cli 0.x on messages",
			ua:   "claude-cli/0.1.5 (external, cli)", endpoint: "POST /v1/messages",
			wantID: ClientAgentQwenCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "claude-cli/0.",
		},
		{
			name: "qwen code native openai endpoint",
			ua:   "QwenCode/0.2.1", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentQwenCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "QwenCode",
		},
		{
			name: "codex cli rust",
			ua:   "codex_cli_rs/0.47.0 (Mac OS 15.1; arm64)", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "codex_cli_rs",
		},
		{
			name: "codex desktop macos chatgpt app user agent",
			ua:   "Codex Desktop/0.153.4 (Mac OS 26.5.2; arm64) unknown (Codex Desktop; 26.903.61454)", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "Codex",
		},
		{
			name: "codex desktop main process user agent",
			ua:   "Codex Desktop/26.820.60940 (Mac OS; arm64)", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "Codex",
		},
		{
			name: "codex desktop windows user agent",
			ua:   "Codex Desktop/26.1007.71326 (Windows NT 10.0; x64)", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "Codex",
		},
		{
			name: "codex desktop unversioned two-word user agent",
			ua:   "Codex Desktop", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "Codex",
		},
		{
			name: "codex desktop embedded inside renderer user agent",
			ua:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Codex Desktop/26.820.60940", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "hermes precedence over codex desktop suffix",
			ua:   "HermesAgent/0.9.2 (Codex Desktop)", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentHermes, wantCat: ClientAgentCategoryAgent, wantPrefix: "HermesAgent",
		},
		{
			name: "codex hyphenated desktop token",
			ua:   "Codex-Desktop/1.2.0", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "Codex-Desktop",
		},
		{
			name: "codex chatgpt desktop originator",
			ua:   "codex_chatgpt_desktop/1.0.0", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "codex_chatgpt_desktop",
		},
		{
			name: "codex vscode and app and atlas and sdk originators",
			ua:   "codex_vscode/1.0.0", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "codex_vscode",
		},
		{
			name: "codex app originator",
			ua:   "codex_app/0.1.0", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "codex_app",
		},
		{
			name: "codex atlas originator",
			ua:   "codex_atlas/1.0.0", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "codex_atlas",
		},
		{
			name: "codex typescript sdk originator",
			ua:   "codex_sdk_ts/1.0.0", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "codex_sdk_ts",
		},
		{
			name: "codex acp extension",
			ua:   "acp-extension-codex/0.4.0", endpoint: "POST /v1/responses",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "acp-extension-codex",
		},
		{
			name: "codex models endpoint client_version query disambiguation",
			ua:   "", endpoint: "GET /v1/models?client_version=0.47.0",
			wantID: ClientAgentCodexCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "opencode channel format",
			ua:   "opencode/latest/1.19.5/cli", endpoint: "POST /v1/messages",
			wantID: ClientAgentOpenCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "opencode",
		},
		{
			name: "gemini cli tui and cloud code vscode",
			ua:   "GeminiCLI-tui/0.66.0/gemini-2.5-pro", endpoint: "POST /v1beta/models/gemini-2.5-pro:generateContent",
			wantID: ClientAgentGeminiCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "GeminiCLI-tui",
		},
		{
			name: "gemini cli lowercase wire token",
			ua:   "geminicli/0.66.0", endpoint: "POST /v1beta/models/gemini-2.5-pro:generateContent",
			wantID: ClientAgentGeminiCLI, wantCat: ClientAgentCategoryAgent, wantPrefix: "geminicli",
		},
		{
			name: "kilo channel format on messages and kilo-code on openai",
			ua:   "kilo/latest/4.2.0/cli", endpoint: "POST /v1/messages",
			wantID: ClientAgentKiloCode, wantCat: ClientAgentCategoryAgent, wantPrefix: "kilo",
		},
		{
			name: "factory droid cli",
			ua:   "factory-cli/1.7.1", endpoint: "POST /v1/messages",
			wantID: ClientAgentDroid, wantCat: ClientAgentCategoryAgent, wantPrefix: "factory-cli",
		},
		{
			name: "openhands and goose and junie",
			ua:   "OpenHands/0.31.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentOpenHands, wantCat: ClientAgentCategoryAgent, wantPrefix: "OpenHands",
		},
		{
			name: "cherry studio inside electron user agent",
			ua:   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CherryStudio/1.2.4 Electron/32.0.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentCherryStudio, wantCat: ClientAgentCategoryAgent, wantPrefix: "",
		},
		{
			name: "n8n partner user agent",
			ua:   "n8n_DatabricksChatModel/1.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentN8n, wantCat: ClientAgentCategoryAgent, wantPrefix: "n8n_DatabricksChatModel",
		},
		{
			name: "word boundary prevents false positives on short agent names",
			ua:   "optimized/1.0", endpoint: "POST /v1/chat/completions",
			wantID: "optimized", wantCat: ClientAgentCategorySDK, wantPrefix: "optimized",
		},
		{
			name: "word boundary prevents decline matching cline",
			ua:   "decline/2.0", endpoint: "POST /v1/chat/completions",
			wantID: "decline", wantCat: ClientAgentCategorySDK, wantPrefix: "decline",
		},
		{
			name: "word boundary prevents compile matching omp or pi",
			ua:   "compile/3.1", endpoint: "POST /v1/chat/completions",
			wantID: "compile", wantCat: ClientAgentCategorySDK, wantPrefix: "compile",
		},
		{
			name: "word boundary prevents stamp matching amp",
			ua:   "stamp/1.0", endpoint: "POST /v1/chat/completions",
			wantID: "stamp", wantCat: ClientAgentCategorySDK, wantPrefix: "stamp",
		},
		{
			name: "word boundary prevents exotic matching exo",
			ua:   "exotic/1.0", endpoint: "POST /v1/chat/completions",
			wantID: "exotic", wantCat: ClientAgentCategorySDK, wantPrefix: "exotic",
		},
		{
			name: "generic sdk python httpx",
			ua:   "python-httpx/0.27.2", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentPythonHTTPX, wantCat: ClientAgentCategorySDK, wantPrefix: "python-httpx",
		},
		{
			name: "generic sdk async openai python",
			ua:   "AsyncOpenAI/Python 1.55.0", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentOpenAISDK, wantCat: ClientAgentCategorySDK, wantPrefix: "AsyncOpenAI",
		},
		{
			name: "generic sdk google genai",
			ua:   "google-genai-sdk/1.2.0", endpoint: "POST /v1beta/models/gemini-2.5-pro:generateContent",
			wantID: ClientAgentGoogleGenAISDK, wantCat: ClientAgentCategorySDK, wantPrefix: "google-genai-sdk",
		},
		{
			name: "generic sdk google genai public go runtime",
			ua:   "google-genai-sdk/1.79.1 gl-go/go1.25.0 X:boringcrypto", endpoint: "POST /v1beta/models/*action",
			wantID: ClientAgentGoogleGenAISDK, wantCat: ClientAgentCategorySDK, wantPrefix: "google-genai-sdk",
		},
		{
			name: "generic sdk google genai public go runtime with short cl token",
			ua:   "google-genai-sdk/1.79.1 gl-go/go1.28-20261102-RC01 cl/123", endpoint: "POST /v1beta/models/*action",
			wantID: ClientAgentGoogleGenAISDK, wantCat: ClientAgentCategorySDK, wantPrefix: "google-genai-sdk",
		},
		{
			name: "generic sdk google genai python runtime",
			ua:   "google-genai-sdk/1.79.1 gl-python/3.12.8", endpoint: "POST /v1beta/models/*action",
			wantID: ClientAgentGoogleGenAISDK, wantCat: ClientAgentCategorySDK, wantPrefix: "google-genai-sdk",
		},
		{
			name: "absent user agent",
			ua:   "", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentUnknown, wantCat: ClientAgentCategoryUnknown, wantPrefix: "",
		},
		{
			name: "secret token in user agent is redacted never leaked",
			ua:   "Bearer sk-secret-token-1234567890", endpoint: "POST /v1/chat/completions",
			wantID: ClientAgentUnknown, wantCat: ClientAgentCategoryUnknown, wantPrefix: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyClientAgent(tc.ua, tc.endpoint)
			if got.ID != tc.wantID || got.Category != tc.wantCat || got.RawPrefix != tc.wantPrefix {
				t.Fatalf("ClassifyClientAgent(%q, %q) = %+v, want ID=%q Cat=%q Prefix=%q",
					tc.ua, tc.endpoint, got, tc.wantID, tc.wantCat, tc.wantPrefix)
			}
		})
	}
}

func TestPersistedClientAttributionAndZeroReadFallback(t *testing.T) {
	// Pre-classified persisted ID and prefix must be kept without re-running UA classification.
	id, prefix := PersistedClientAttribution(ClientAgentCherryStudio, "", "Mozilla/5.0", "POST /v1/chat/completions")
	if id != ClientAgentCherryStudio || prefix != "" {
		t.Fatalf("PersistedClientAttribution persisted cherry-studio = (%q, %q)", id, prefix)
	}
	id, prefix = PersistedClientAttribution(ClientAgentQwenCode, "claude-cli/0.", "claude-cli/0.1.5", "")
	if id != ClientAgentQwenCode || prefix != "claude-cli/0." {
		t.Fatalf("PersistedClientAttribution persisted qwen-code = (%q, %q)", id, prefix)
	}
	// Secret-bearing or whitespace-padded prefixes passed directly to storage are sanitized.
	id, prefix = PersistedClientAttribution(ClientAgentClaudeCode, "Bearer sk-secret-value-1234", "", "")
	if id != ClientAgentClaudeCode || prefix != "" {
		t.Fatalf("PersistedClientAttribution secret prefix = (%q, %q)", id, prefix)
	}
	id, prefix = PersistedClientAttribution(ClientAgentUnknown, "claude-cli/2.", "claude-cli/2.1.14", "")
	if id != ClientAgentUnknown || prefix != "" {
		t.Fatalf("PersistedClientAttribution unknown drops prefix = (%q, %q)", id, prefix)
	}

	// Empty stored ID classifies once from raw User-Agent and endpoint.
	id, prefix = PersistedClientAttribution("", "", "codex_cli_rs/0.47.0", "POST /v1/responses")
	if id != ClientAgentCodexCLI || prefix != "codex_cli_rs" {
		t.Fatalf("PersistedClientAttribution fallback codex = (%q, %q)", id, prefix)
	}
	id, prefix = PersistedClientAttribution("", "", "", "GET /v1/models?client_version=0.47")
	if id != ClientAgentCodexCLI || prefix != "" {
		t.Fatalf("PersistedClientAttribution fallback codex models query = (%q, %q)", id, prefix)
	}

	// Read projection maps empty and "unknown" to "" with zero UA fallback.
	if got := ClientAgentFromPersisted(ClientAgentUnknown); got != "" {
		t.Fatalf("ClientAgentFromPersisted(unknown) = %q, want empty", got)
	}
	if got := ClientAgentFromPersisted(""); got != "" {
		t.Fatalf("ClientAgentFromPersisted('') = %q, want empty", got)
	}
	if got := ClientAgentFromPersisted(ClientAgentGrokBuild); got != ClientAgentGrokBuild {
		t.Fatalf("ClientAgentFromPersisted(grok-build) = %q", got)
	}

	// Historical migration helper preserves pre-067/068 prefix and fallback resolution.
	got := ResolveHistoricalClientAttribution(ClientAgentCherryStudio, "Mozilla/5.0", "POST /v1/chat/completions")
	if got.ID != ClientAgentCherryStudio || got.Category != ClientAgentCategoryAgent || got.RawPrefix != "" {
		t.Fatalf("ResolveHistoricalClientAttribution persisted cherry-studio = %+v", got)
	}
	legacy := ResolveHistoricalClientAttribution("", "codex_cli_rs/0.47.0", "POST /v1/responses")
	if legacy.ID != ClientAgentCodexCLI || legacy.Category != ClientAgentCategoryAgent || legacy.RawPrefix != "codex_cli_rs" {
		t.Fatalf("ResolveHistoricalClientAttribution legacy fallback = %+v", legacy)
	}
	qwen := ResolveHistoricalClientAttribution(ClientAgentQwenCode, "claude-cli/0.1.5", "")
	if qwen.ID != ClientAgentQwenCode || qwen.RawPrefix != "claude-cli/0." {
		t.Fatalf("ResolveHistoricalClientAttribution persisted qwen-code = %+v", qwen)
	}

	hermesCodex := ResolveHistoricalClientAttribution(ClientAgentHermes, "codex_cli_rs/0.0.0", "POST /v1/responses")
	if hermesCodex.ID != ClientAgentHermes || hermesCodex.Category != ClientAgentCategoryAgent || hermesCodex.RawPrefix != "" {
		t.Fatalf("ResolveHistoricalClientAttribution persisted hermes over codex_cli_rs = %+v", hermesCodex)
	}
	if histCodex := ResolveHistoricalClientAttribution("", "Codex", "POST /v1/responses"); histCodex.ID != ClientAgentCodexCLI || histCodex.Category != ClientAgentCategoryAgent || histCodex.RawPrefix != "Codex" {
		t.Fatalf("ResolveHistoricalClientAttribution historical minimized Codex = %+v", histCodex)
	}
	if histCodexStored := ResolveHistoricalClientAttribution("codex", "Codex", "POST /v1/responses"); histCodexStored.ID != "codex" || histCodexStored.RawPrefix != "Codex" {
		t.Fatalf("ResolveHistoricalClientAttribution persisted codex + minimized Codex = %+v", histCodexStored)
	}
	if histAlias := ResolveHistoricalClientAttribution("codex_chatgpt_desktop", "codex_chatgpt_desktop/1.0.0", "POST /v1/responses"); histAlias.ID != "codex_chatgpt_desktop" || histAlias.RawPrefix != "codex_chatgpt_desktop" {
		t.Fatalf("ResolveHistoricalClientAttribution persisted codex_chatgpt_desktop = %+v", histAlias)
	}
	if histUnrelated := ResolveHistoricalClientAttribution("custom-sdk", "codex_chatgpt_desktop/1.0.0", "POST /v1/responses"); histUnrelated.ID != "custom-sdk" || histUnrelated.RawPrefix != "" {
		t.Fatalf("ResolveHistoricalClientAttribution unrelated stored id = %+v", histUnrelated)
	}
	if histCodexCanonical := ResolveHistoricalClientAttribution(ClientAgentCodexCLI, "Codex", "POST /v1/responses"); histCodexCanonical.ID != ClientAgentCodexCLI || histCodexCanonical.RawPrefix != "Codex" {
		t.Fatalf("ResolveHistoricalClientAttribution canonical codex-cli + minimized Codex = %+v", histCodexCanonical)
	}
	if histUnknown := ResolveHistoricalClientAttribution(ClientAgentUnknown, "Codex", "POST /v1/responses"); histUnknown.ID != ClientAgentUnknown || histUnknown.RawPrefix != "" {
		t.Fatalf("ResolveHistoricalClientAttribution persisted unknown stays unknown = %+v", histUnknown)
	}
	if id, prefix := PersistedClientAttribution(ClientAgentHermes, "", "codex_cli_rs/0.0.0", "POST /v1/responses"); id != ClientAgentHermes || prefix != "" {
		t.Fatalf("PersistedClientAttribution persisted hermes over codex_cli_rs = (%q, %q)", id, prefix)
	}

	// Bare "Hermes" without version or trailing "Agent" must stay guarded against false positives.
	if bareHermes := ClassifyClientAgent("Hermes", "POST /v1/chat/completions"); bareHermes.ID != ClientAgentUnknown {
		t.Fatalf("ClassifyClientAgent(\"Hermes\") = %+v, want unknown", bareHermes)
	}

	if id, _ := PersistedClientAttribution(ClientAgentGrokBuild, "", "grok-shell/0.2.106", "POST /v1/responses"); ClientAgentFromPersisted(id) != ClientAgentGrokBuild {
		t.Fatalf("PersistedClientAttribution persisted grok-build = %q", id)
	}
	if id, prefix := PersistedClientAttribution("", "", "MiniMaxCode/0.6.8", "POST /v1/messages"); ClientAgentFromPersisted(id) != ClientAgentMiniMaxCode || prefix != "MiniMaxCode" {
		t.Fatalf("PersistedClientAttribution fallback minimax-code = (%q, %q)", id, prefix)
	}

	// Unversioned guarded short tokens must not bypass the version gate via persistence.
	for _, bare := range []string{"amp", "void", "pi", "codex", "Codex", "omp", "dsh", "agy", "other", "unknown"} {
		classified := ClassifyClientAgent(bare, "POST /v1/messages")
		if classified.ID != ClientAgentUnknown || classified.Category != ClientAgentCategoryUnknown {
			t.Fatalf("ClassifyClientAgent(%q) = %+v, want unknown", bare, classified)
		}
		persistedID, persistedPrefix := PersistedClientAttribution("", "", bare, "POST /v1/messages")
		if persistedID != ClientAgentUnknown || persistedPrefix != "" {
			t.Fatalf("PersistedClientAttribution(%q) = (%q, %q), want unknown", bare, persistedID, persistedPrefix)
		}
		if readID := ClientAgentFromPersisted(persistedID); readID != "" {
			t.Fatalf("ClientAgentFromPersisted(%q) = %q, want empty", persistedID, readID)
		}
	}
}

func TestRedactionFastPathEquivalenceAndZeroAllocHotPath(t *testing.T) {
	inputs := []string{
		"",
		"claude-cli/2.1.14 (external, cli)",
		"codex_cli_rs/0.47.0 (Mac OS 15.1; arm64)",
		"grok-shell/0.2.106 (linux; x86_64)",
		"deepseek-harness/0.2.1-rc.3 (+https://github.com/deepseek-ai/deepseek-harness)",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Maka/0.1.11 Electron/43.2.0",
		"Bearer sk-" + strings.Repeat("s", 16),
		"Authorization: Basic " + strings.Repeat("z", 12),
		"custom-client/1.0?api_key=sk-" + strings.Repeat("f", 16),
		"ghp_" + strings.Repeat("a", 16),
		"ghs_" + strings.Repeat("b", 16),
		"github_" + "pat_" + strings.Repeat("c", 16),
		"glpat-" + strings.Repeat("d", 16),
		"hindsight/1.2.0",
		"google-genai-sdk/1.79.1 gl-go/go1.28-20261102-RC01 cl/1012564305 +298f53e483 X:fieldtrack,boringcrypto,nogolistexportnewformat",
		"xoxb-" + strings.Repeat("e", 16),
		"client\x00with-nul/1.0",
	}
	for _, raw := range inputs {
		gotRedacted := redactUserAgentIfNeeded(raw)
		wantRedacted := strings.TrimSpace(security.RedactText(raw))
		if gotRedacted != wantRedacted {
			t.Fatalf("redactUserAgentIfNeeded(%q) = %q, want %q", raw, gotRedacted, wantRedacted)
		}
		gotMin := minimizedFromRedacted(gotRedacted)
		wantMin := ""
		if ptr := security.MinimizeUserAgent(raw); ptr != nil {
			wantMin = *ptr
		}
		if gotMin != wantMin {
			t.Fatalf("minimizedFromRedacted(%q) = %q, want %q", raw, gotMin, wantMin)
		}
	}

	canonicalIDs := make([]string, 0, len(knownAgentIDs)+len(knownSDKIDs)+1)
	canonicalIDs = append(canonicalIDs, ClientAgentUnknown)
	for id := range knownAgentIDs {
		canonicalIDs = append(canonicalIDs, id)
	}
	for id := range knownSDKIDs {
		canonicalIDs = append(canonicalIDs, id)
	}

	if allocs := testing.AllocsPerRun(200, func() {
		_ = ClassifyClientAgent("claude-cli/2.1.14 (external, cli)", "POST /v1/messages")
		_ = ClassifyClientAgent("codex_cli_rs/0.47.0 (Mac OS 15.1; arm64)", "POST /v1/responses")
		_ = ClassifyClientAgent("Codex Desktop/0.153.4 (Mac OS 26.5.2; arm64) unknown (Codex Desktop; 26.903.61454)", "POST /v1/responses")
		_ = ClassifyClientAgent("codex_chatgpt_desktop/1.0.0", "POST /v1/responses")
		_ = ClassifyClientAgent("codex_cli_rs/0.0.0 (Hermes Agent)", "POST /v1/responses")
		_ = ClassifyClientAgent("HermesAgent/0.9.2", "POST /v1/chat/completions")
		_ = ClassifyClientAgent("hindsight/1.2.0", "POST /v1/chat/completions")
		_ = ClassifyClientAgent("QwenCode/0.2.1", "POST /v1/chat/completions")
		_ = ClassifyClientAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Maka/0.1.11 Electron/43.2.0", "POST /v1/chat/completions")
		_ = ClassifyClientAgent("google-genai-sdk/1.79.1 gl-go/go1.28-20261102-RC01 cl/1012564305 +298f53e483", "POST /v1beta/models/*action")
		_ = ClassifyClientAgent("AsyncOpenAI/Python 1.55.0", "POST /v1/chat/completions")
		_ = ResolveHistoricalClientAttribution("", "Codex", "POST /v1/responses")
		_ = ResolveHistoricalClientAttribution("codex_chatgpt_desktop", "codex_chatgpt_desktop/1.0.0", "POST /v1/responses")
		for _, id := range canonicalIDs {
			_, _ = PersistedClientAttribution(id, "hindsight", "hindsight/1.2.0", "POST /v1/chat/completions")
			_ = ClientAgentFromPersisted(id)
			_ = ResolveHistoricalClientAttribution(id, "hindsight/1.2.0", "")
		}
	}); allocs != 0 {
		t.Fatalf("expected 0 heap allocations on clean hot paths, got %v", allocs)
	}
}

func BenchmarkClassifyClientAgent(b *testing.B) {
	samples := [][2]string{
		{"claude-cli/2.1.14 (external, cli)", "POST /v1/messages"},
		{"codex_cli_rs/0.47.0 (Mac OS 15.1; arm64)", "POST /v1/responses"},
		{"grok-shell/0.2.106 (linux; x86_64)", "POST /v1/responses"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CherryStudio/1.2.4 Electron/32.0.0", "POST /v1/chat/completions"},
		{"OpenAI/Python 1.55.0", "POST /v1/chat/completions"},
		{"claude-cli/0.1.5 (external, cli)", "POST /v1/messages"},
	}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		pair := samples[i%len(samples)]
		_ = ClassifyClientAgent(pair[0], pair[1])
	}
}

func BenchmarkPersistedClientAttribution(b *testing.B) {
	b.Run("PersistedOnly", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_, _ = PersistedClientAttribution(ClientAgentClaudeCode, "claude-cli/2.", "claude-cli/2.1.14", "POST /v1/messages")
		}
	})
	b.Run("ReadProjection", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = ClientAgentFromPersisted(ClientAgentClaudeCode)
		}
	})
}
