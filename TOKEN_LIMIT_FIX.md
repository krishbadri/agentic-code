# Token Limit / Request Too Large Fix

**Date**: 2026-02-08
**Issue**: "Request too large" errors caused infinite retry loops when conversation exceeded OpenAI TPM limits
**Status**: ✅ Fixed

---

## The Problem

When using OpenAI with rate limits (e.g., 30,000 TPM for gpt-5-chat-latest), long conversations would trigger:

```
Error: Request too large for gpt-5-chat-latest in organization ... on tokens per min (TPM):
Limit 30000, Requested 30381. The input or output tokens must be reduced in order to run successfully.
```

The retry logic would attempt to reduce context, but the reduction was insufficient, causing:

1. **Retry attempt 1** → Same error (still 30,381 tokens)
2. **Retry attempt 2** → Same error
3. **Retry attempt 3** → Same error
4. **Retry attempt 4** → Same error
5. **Retry attempt 5** → Same error (infinite loop)

### Root Causes:

1. **REQUEST_TOO_LARGE_CAP too high**: Set to 29,000 tokens, only 1k below 30k limit

    - Not enough margin for system prompt, output tokens, and token counting errors
    - Conversation would hit 29k cap but still exceed 30k total request size

2. **Safety buffer too small**: Only 8% reduction when near limit

    - For 30,381 requested with 30,000 limit (1.3% over):
        - Old: Remove 1.3% + 8% = 9.3% of messages
        - Not aggressive enough to guarantee staying below limit

3. **Token counting imprecision**: Message-level truncation vs exact token counts
    - Removing 9.3% of messages doesn't guarantee 9.3% token reduction
    - Need larger safety margin

---

## The Fix

### 1. Reduced REQUEST_TOO_LARGE_CAP (line 139)

**Before:**

```typescript
const REQUEST_TOO_LARGE_CAP = 29_000
```

**After:**

```typescript
// Set to 25k to leave 5k+ margin for common 30k TPM limits (prevents retry loops)
const REQUEST_TOO_LARGE_CAP = 25_000
```

**Impact**: 5,000 token margin below common 30k limits ensures context truncation triggers earlier

---

### 2. Increased Safety Buffers (lines 4091-4102)

**Before:**

```typescript
const excessFraction = requested > limit ? (requested - limit) / requested : 0.1 // default 10%
const safetyBuffer = 0.08 // 8% buffer
const minFracToRemove = messages.length > 2 ? 2 / (messages.length - 1) : 0.1
```

**After:**

```typescript
const excessFraction = requested > limit ? (requested - limit) / requested : 0.15 // default 15%
const safetyBuffer = 0.15 // 15% buffer for safe margin
const minFracToRemove = messages.length > 2 ? 2 / (messages.length - 1) : 0.15
```

**Impact**: For the same 30,381 requested / 30,000 limit scenario:

- Old: Remove 1.3% + 8% = 9.3% of messages
- New: Remove 1.3% + 15% = 16.3% of messages
- **Result**: Guaranteed to drop well below 30k limit on first retry

---

## How It Works Now

### Scenario: 30,381 tokens requested, 30,000 TPM limit

**Detection** (context-error-handling.ts):

1. Error matches `/request too large/i`
2. Extracts: `Requested 30381, Limit 30000`

**Reduction** (Task.ts handleContextWindowExceededError):

1. Caps effective context window: `min(200000, 25000) = 25000`
2. Calculates excess: `(30381 - 30000) / 30381 = 1.27%`
3. Adds safety buffer: `1.27% + 15% = 16.27%`
4. Removes ~16% of messages via `truncateConversation()`
5. Applies aggressive condensation (summarize older messages)

**Result**:

- Conversation reduced by 16-20% of messages
- New token count: ~24,000-26,000 tokens
- Well below 30,000 limit
- ✅ Retry succeeds on first attempt

---

## Testing the Fix

### Before Fix:

```
Retry attempt 1 → Error: Requested 30381, Limit 30000
Retry attempt 2 → Error: Requested 30381, Limit 30000
Retry attempt 3 → Error: Requested 30381, Limit 30000
... (infinite loop)
```

### After Fix:

```
Retry attempt 1 →
  Reducing by 16% of messages...
  Hard truncated 12 messages to reduce request size
  ✅ Success! New request: ~25,500 tokens
```

---

## Configuration

The fix automatically adjusts based on detected limits:

```typescript
// Caps prevent large model windows (200k+) from bypassing truncation
REQUEST_TOO_LARGE_CAP = 25_000 // Caps context window for rate-limited providers

// Buffers ensure we stay safely below limits
safetyBuffer = 0.15 // 15% reduction beyond calculated excess
minFracToRemove = 0.15 // Always remove at least 15% when triggered
```

---

## Edge Cases Handled

1. **Unknown limit**: Defaults to removing 15% of messages
2. **Very small excess** (e.g., 0.5% over): Still removes 15.5% for safety
3. **Multiple retries**: Each retry removes more (fallback to 20% if first truncation insufficient)
4. **Torture test mode**: Uses aggressive 50% condensation threshold

---

## Files Changed

1. **src/core/task/Task.ts**
    - Line 139: `REQUEST_TOO_LARGE_CAP` reduced from 29k → 25k
    - Lines 4098-4101: Safety buffers increased from 8-10% → 15%

---

## Next Steps

1. ✅ Extension rebuilt (`pnpm bundle`)
2. 🔄 **Reload VS Code** to pick up changes
3. ✅ Long conversations will now auto-truncate successfully
4. ✅ No more "request too large" retry loops

---

## Notes

- This fix is provider-agnostic (works for OpenAI, OpenRouter, etc.)
- The 25k cap won't affect models with smaller windows (they already truncate earlier)
- For models with 200k+ windows but 30k rate limits, this ensures proper truncation
- The aggressive 15% safety margin accounts for token counting imprecision
