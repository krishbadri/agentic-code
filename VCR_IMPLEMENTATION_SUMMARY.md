# VCR Implementation Summary

## Files Added

### Core VCR Module (`src/api/vcr/`)
- `vcrConfig.ts` - Environment variable configuration and mode detection
- `redaction.ts` - Deep redaction of sensitive fields (apiKey, token, secret, authorization)
- `key.ts` - Stable key generation using SHA256 hash of normalized request descriptor
- `recordReplay.ts` - Core record/replay logic with stream wrapping
- `README.md` - Usage documentation

### Tests (`src/api/vcr/__tests__/`)
- `vcr.integration.spec.ts` - Integration tests with fake streams (OpenAI-style and Anthropic-style)
- `redaction.spec.ts` - Unit tests for redaction logic
- `key.spec.ts` - Unit tests for key generation stability

## Files Modified

### Provider Integrations
- `src/api/providers/openai.ts` - Added VCR wrapper after `client.chat.completions.create()`
- `src/api/providers/base-openai-compatible-provider.ts` - Added VCR wrapper in `createMessage()` after `createStream()`
- `src/api/providers/anthropic.ts` - Added VCR wrapper after `client.messages.create()`

## How Keying Works

1. **Request Descriptor**: Created from provider name, model ID, endpoint type, and request parameters
2. **Normalization**: Deep clone and redact sensitive fields (apiKey, token, secret, authorization)
3. **Hashing**: JSON.stringify with sorted keys → SHA256 hash → first 16 chars
4. **File Path**: `${ROO_VCR_DIR}/${providerName}/${sanitizedModelId}/${hash}.json`

**Key Properties**:
- Same request → same hash (deterministic)
- Different apiKey values → same hash (redacted before hashing)
- Different messages/temperature → different hash

## How to Run Record/Replay in Tests

### Recording
```bash
# Set environment and run tests
ROO_VCR_MODE=record ROO_VCR_DIR=/tmp/vcr-test pnpm test src/api/vcr
```

### Replaying
```bash
# Replay recorded fixtures (no network calls)
ROO_VCR_MODE=replay ROO_VCR_DIR=/tmp/vcr-test pnpm test src/api/vcr
```

### Example Test Pattern
```typescript
beforeEach(() => {
  process.env.ROO_VCR_MODE = "record"
  process.env.ROO_VCR_DIR = tempDir
})

it("should record and replay", async () => {
  // First run: records to disk
  // Second run (with ROO_VCR_MODE=replay): replays from disk
})
```

## Limitations

1. **JSON Serialization**: All chunk objects must be JSON-serializable. The implementation uses `JSON.stringify()` which handles:
   - Primitives (string, number, boolean, null)
   - Arrays and objects
   - Nested structures
   - **Not handled**: Functions, Symbols, undefined (will be omitted), circular references (will throw)

2. **Stream Completion**: Recording only writes to disk after the stream completes. If a test fails mid-stream, the recording may be incomplete.

3. **Type Safety**: The VCR wrapper returns `AsyncIterable<unknown>` which is then cast to the provider's stream type. This is safe because:
   - Record mode: passes through the original stream unchanged
   - Replay mode: yields the exact same objects that were recorded

4. **Provider-Specific Types**: Some SDK types (like `AnthropicStream`) are not preserved in replay mode - the stream is a plain async generator. This is fine because the consuming code only iterates over chunks, not the stream object itself.

5. **Non-Deterministic Fields**: The `createdAt` timestamp in recording metadata is non-deterministic, but this doesn't affect replay correctness since it's only in metadata.

## Architecture Decisions

1. **Stream Wrapping**: Wraps the SDK stream rather than intercepting at HTTP level - simpler, works with any SDK
2. **Atomic Writes**: Uses temp file + rename to ensure recordings are complete or missing (never partial)
3. **Redaction Before Hashing**: Ensures same request with different API keys produces same hash
4. **Minimal Invasiveness**: Only adds ~10 lines per provider file, behind `isVcrEnabled()` check
5. **No Production Impact**: When `ROO_VCR_MODE=off` (default), zero overhead - just a boolean check

## Testing Strategy

Tests use **fake streams** (async generators) to simulate provider responses:
- No real SDK clients needed
- No network calls
- Fast execution
- Deterministic

This allows testing the VCR logic in isolation without requiring:
- VS Code Extension Host
- Real API keys
- Network connectivity
- Provider SDKs
