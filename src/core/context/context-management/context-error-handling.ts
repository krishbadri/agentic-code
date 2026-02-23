import { APIError } from "openai"

export function checkContextWindowExceededError(error: unknown): boolean {
	return (
		checkIsOpenAIContextWindowError(error) ||
		checkIsOpenRouterContextWindowError(error) ||
		checkIsAnthropicContextWindowError(error) ||
		checkIsCerebrasContextWindowError(error) ||
		checkIsRequestTooLargeError(error)
	)
}

/** Parse requested/limit from "Request too large... Limit 30000, Requested 30330" style errors */
export function parseRequestTooLargeNumbers(error: unknown): { requested: number; limit: number } | null {
	try {
		if (!error || typeof error !== "object") return null
		const err = error as Record<string, unknown>
		const raw = (err.error as any)?.metadata?.raw
		const msg = err.message ?? (err.error as any)?.message ?? (typeof raw === "string" ? raw : (raw?.message ?? ""))
		let combined = typeof msg === "object" ? JSON.stringify(msg) : String(msg)
		if (!combined) combined = JSON.stringify(error)
		const requestedMatch = combined.match(/requested\s+(\d+)/i)
		const limitMatch = combined.match(/limit\s+(\d+)/i)
		if (requestedMatch && limitMatch) {
			const requested = parseInt(requestedMatch[1], 10)
			const limit = parseInt(limitMatch[1], 10)
			if (requested > 0 && limit > 0) return { requested, limit }
		}
		return null
	} catch {
		return null
	}
}

/**
 * Detect TPM (tokens per minute) rate limit errors.
 * These are NOT context window errors - they require WAITING for the rate limit window to reset.
 * Example: "Request too large for gpt-5-chat-latest... on tokens per min (TPM): Limit 30000, Requested 30513"
 */
export function checkIsTPMRateLimitError(error: unknown): boolean {
	try {
		if (!error || typeof error !== "object") return false
		const err = error as Record<string, unknown>
		const raw = (err.error as any)?.metadata?.raw
		const msg = err.message ?? (err.error as any)?.message ?? (typeof raw === "string" ? raw : (raw?.message ?? ""))
		let combined = typeof msg === "object" ? JSON.stringify(msg) : String(msg)
		if (!combined) combined = JSON.stringify(error)
		// TPM errors contain "tokens per min" or "TPM" in the context of rate limiting
		if (/tokens?\s+per\s+min/i.test(combined)) return true
		if (/\bTPM\b/.test(combined)) return true
		return false
	} catch {
		return false
	}
}

/**
 * Detect "request too large" errors (payload exceeds limit).
 * Retrying without truncation will keep failing - we must condense context first.
 * TPM/rate limit errors are handled separately (wait and retry).
 */
function checkIsRequestTooLargeError(error: unknown): boolean {
	try {
		if (!error || typeof error !== "object") return false
		// TPM errors should be treated as rate limits, not context window errors
		if (checkIsTPMRateLimitError(error)) return false
		const err = error as Record<string, unknown>
		const raw = (err.error as any)?.metadata?.raw
		const msg = err.message ?? (err.error as any)?.message ?? (typeof raw === "string" ? raw : (raw?.message ?? ""))
		let combined = typeof msg === "object" ? JSON.stringify(msg) : String(msg)
		if (!combined) combined = JSON.stringify(error)
		// Match "request too large" or "reduce...tokens" or "Requested X" exceeds "Limit Y" (payload too big)
		if (/request\s+too\s+large/i.test(combined)) return true
		if (/reduce.*(?:the\s+)?(?:input\s+or\s+output\s+)?tokens?/i.test(combined)) return true
		// "Requested 30403" with "Limit 30000" = need to shrink
		const requestedMatch = combined.match(/requested\s+(\d+)/i)
		const limitMatch = combined.match(/limit\s+(\d+)/i)
		if (requestedMatch && limitMatch) {
			const requested = parseInt(requestedMatch[1], 10)
			const limit = parseInt(limitMatch[1], 10)
			if (requested > limit) return true
		}
		return false
	} catch {
		return false
	}
}

function checkIsOpenRouterContextWindowError(error: unknown): boolean {
	try {
		if (!error || typeof error !== "object") {
			return false
		}

		// Use Record<string, any> for proper type narrowing
		const err = error as Record<string, any>
		const status = err.status ?? err.code ?? err.error?.status ?? err.response?.status
		const message: string = String(err.message || err.error?.message || "")

		// Known OpenAI/OpenRouter-style signal (code 400 and message includes "context length" or "request too large")
		const CONTEXT_ERROR_PATTERNS = [
			/\bcontext\s*(?:length|window)\b/i,
			/\bmaximum\s*context\b/i,
			/\b(?:input\s*)?tokens?\s*exceed/i,
			/\btoo\s*many\s*tokens?\b/i,
			/\brequest\s*too\s*large\b/i,
			/\breduce\s*(?:the\s*)?tokens?\b/i,
			/\breduce\s*(?:the\s*)?length\b/i,
		] as const

		return String(status) === "400" && CONTEXT_ERROR_PATTERNS.some((pattern) => pattern.test(message))
	} catch {
		return false
	}
}

// Docs: https://platform.openai.com/docs/guides/error-codes/api-errors
function checkIsOpenAIContextWindowError(error: unknown): boolean {
	try {
		// Check for LengthFinishReasonError
		if (error && typeof error === "object" && "name" in error && error.name === "LengthFinishReasonError") {
			return true
		}

		const KNOWN_CONTEXT_ERROR_SUBSTRINGS = ["token", "context length"] as const

		return (
			Boolean(error) &&
			error instanceof APIError &&
			error.code?.toString() === "400" &&
			KNOWN_CONTEXT_ERROR_SUBSTRINGS.some((substring) => error.message.includes(substring))
		)
	} catch {
		return false
	}
}

function checkIsAnthropicContextWindowError(response: unknown): boolean {
	try {
		// Type guard to safely access properties
		if (!response || typeof response !== "object") {
			return false
		}

		// Use type assertions with proper checks
		const res = response as Record<string, any>

		// Check for Anthropic-specific error structure with more specific validation
		if (res.error?.error?.type === "invalid_request_error") {
			const message: string = String(res.error?.error?.message || "")

			// More specific patterns for context window errors
			const contextWindowPatterns = [
				/prompt is too long/i,
				/maximum.*tokens/i,
				/context.*too.*long/i,
				/exceeds.*context/i,
				/token.*limit/i,
				/context_length_exceeded/i,
				/max_tokens_to_sample/i,
			]

			// Additional check for Anthropic-specific error codes
			const errorCode = res.error?.error?.code
			if (errorCode === "context_length_exceeded" || errorCode === "invalid_request_error") {
				return contextWindowPatterns.some((pattern) => pattern.test(message))
			}

			return contextWindowPatterns.some((pattern) => pattern.test(message))
		}

		return false
	} catch {
		return false
	}
}

function checkIsCerebrasContextWindowError(response: unknown): boolean {
	try {
		// Type guard to safely access properties
		if (!response || typeof response !== "object") {
			return false
		}

		// Use type assertions with proper checks
		const res = response as Record<string, any>
		const status = res.status ?? res.code ?? res.error?.status ?? res.response?.status
		const message: string = String(res.message || res.error?.message || "")

		return String(status) === "400" && message.includes("Please reduce the length of the messages or completion")
	} catch {
		return false
	}
}
