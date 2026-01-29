# VCR Readiness Report for Roo Code Fork

## Provider Callsites

### OpenAI (`src/api/providers/openai.ts`)
- **Function**: `OpenAiHandler.createMessage()` (line 83)
- **Request**: `this.client.chat.completions.create(requestOptions)` (line 174)
- **Request Shape**: `OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming`
  - `model`, `temperature`, `messages`, `stream: true`, `stream_options: { include_usage: true }`
- **Response Shape**: AsyncIterable of chunks with `chunk.choices[0].delta` (content, tool_calls) and `chunk.usage`
- **Streaming**: ✅ Yes (default: `openAiStreamingEnabled ?? true`)

### Anthropic (`src/api/providers/anthropic.ts`)
- **Function**: `AnthropicHandler.createMessage()` (line 39)
- **Request**: `this.client.messages.create({ model, max_tokens, temperature, system, messages, stream: true })` (line 85)
- **Request Shape**: `Anthropic.Messages.MessageCreateParams` with `stream: true`
- **Response Shape**: `AnthropicStream<Anthropic.Messages.RawMessageStreamEvent>`
  - Event types: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- **Streaming**: ✅ Yes (always)

### Groq (`src/api/providers/groq.ts`)
- **Function**: `GroqHandler.createMessage()` (line 33)
- **Request**: Inherits from `BaseOpenAiCompatibleProvider.createStream()` → `this.client.chat.completions.create()` (line 89 in base)
- **Request Shape**: Same as OpenAI (OpenAI-compatible)
- **Response Shape**: Same as OpenAI (chunks with `delta.content`, `usage`)
- **Streaming**: ✅ Yes

### Base OpenAI-Compatible (`src/api/providers/base-openai-compatible-provider.ts`)
- **Function**: `BaseOpenAiCompatibleProvider.createMessage()` (line 95)
- **Request**: `this.client.chat.completions.create(params)` (line 89)
- **Used by**: Groq, OpenRouter, LiteLLM, DeepInfra, and 20+ other providers
- **Streaming**: ✅ Yes

## Streaming vs Non-Streaming

**Streaming**: ✅ **YES - All providers use streaming by default**

- **Default path**: Streaming (`stream: true`)
- **Parsing locations**:
  - **OpenAI**: `src/api/providers/openai.ts:193` - `for await (const chunk of stream)` → `chunk.choices[0].delta.content`
  - **Anthropic**: `src/api/providers/anthropic.ts:155` - `for await (const chunk of stream)` → `chunk.type` switch
  - **Tool calls parsed from**: `delta.tool_calls` (OpenAI) or XML parsing from text content (Anthropic/OpenAI)
- **Non-streaming**: Only in `completePrompt()` helper (`base-openai-compatible-provider.ts:122`) - not used in main flow

## Tool Protocol Selection

**Location**: `packages/types/src/provider-settings.ts:591` - `getApiProtocol()`

**Decision Logic**:
```typescript
export const getApiProtocol = (provider: ProviderName | undefined, modelId?: string): "anthropic" | "openai" => {
  if (provider && ANTHROPIC_STYLE_PROVIDERS.includes(provider)) return "anthropic"
  if (provider === "vertex" && modelId?.toLowerCase().includes("claude")) return "anthropic"
  if (provider === "vercel-ai-gateway" && modelId?.toLowerCase().startsWith("anthropic/")) return "anthropic"
  return "openai" // Default
}
```

**Tool Call Format**:
- **XML tags** (always): `<read_file><args><file><path>...</path></file></args></read_file>`
- **Parsing**: `src/core/assistant-message/parseAssistantMessageV2.ts` - XML parser
- **Repair**: `src/core/assistant-message/toolCallRepairer.ts` - Converts function-call syntax to XML
- **Note**: Even OpenAI providers use XML (not native `tool_calls`). Protocol determines response format, not tool format.

## Test Harness

**Framework**: Vitest (`vitest.config.ts`)
- **Command**: `pnpm test` (runs `vitest run` via turbo)
- **Setup**: `src/vitest.setup.ts` - Uses `nock` to disable network by default
- **VS Code Mock**: `src/__mocks__/vscode.js` (aliased in vitest.config.ts)
- **Feasibility**: ✅ **YES - Pure unit tests work** (nock mocks HTTP, vscode mocked)
- **Test Location**: `src/api/providers/__tests__/` (e.g., `openai.spec.ts` uses mocked OpenAI client)

## Fixture Directory Recommendation

**Proposed**: `src/__tests__/__fixtures__/vcr/`

**Rationale**:
- Follows existing pattern: `src/__tests__/` for tests
- `__fixtures__` is common convention
- `vcr/` subdirectory for VCR-specific recordings
- Structure: `vcr/{provider}/{model}/{test-name}.json`

**Alternative**: `src/api/providers/__tests__/__fixtures__/vcr/` (co-located with provider tests)

## Redaction Targets

**Headers to redact**:
- `Authorization: Bearer {apiKey}` (line 466 in `openai.ts`)
- `apiKey` field in client initialization (lines 42, 58, 68, 76 in `openai.ts`)
- `apiKey` in `Anthropic` constructor (line 35 in `anthropic.ts`)
- `groqApiKey`, `openAiApiKey`, `anthropicApiKey` in options

**Request body fields**:
- `apiKey`, `api_key`, `authToken` in any request body
- Any field matching pattern: `*apiKey*`, `*api_key*`, `*token*`

**Response fields**:
- None (responses don't contain secrets)

**Constants**:
- `DEFAULT_HEADERS` (`src/api/providers/constants.ts`) - Contains `User-Agent` and `X-Title` (safe to keep)

**Note**: API keys are passed via constructor/options, not in request bodies for OpenAI/Anthropic SDKs.
