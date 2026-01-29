/**
 * Global Rate Limit Coordinator
 * 
 * Prevents rate limit cascades by coordinating API requests across all tasks/subtasks.
 * When a 429 error is encountered, all pending requests wait for the rate limit window to reset.
 */

/**
 * Check if an error is a rate limit error (429)
 * Checks both status code and error message patterns
 */
export function isRateLimitError(error: any): boolean {
	// Check for status code 429
	if (error?.status === 429 || error?.statusCode === 429) {
		return true
	}
	
	// Check error message for rate limit indicators
	const errorMessage = error?.message || error?.error?.message || String(error || "")
	if (errorMessage && typeof errorMessage === "string") {
		return /429|rate limit|rate limit reached|rate limit exceeded/i.test(errorMessage)
	}
	
	return false
}

/**
 * Check if an error is an authentication error (401)
 * Authentication errors should fail fast - they won't succeed on retry
 * Checks both status code and error message patterns
 */
export function isAuthenticationError(error: any): boolean {
	// Check for status code 401
	if (error?.status === 401 || error?.statusCode === 401) {
		return true
	}
	
	// Check error message for authentication error indicators
	const errorMessage = error?.message || error?.error?.message || String(error || "")
	if (errorMessage && typeof errorMessage === "string") {
		return /401|incorrect api key|invalid api key|authentication failed|unauthorized|not-provided/i.test(errorMessage)
	}
	
	return false
}

/**
 * Check if an error is a billing/credits error (402)
 * Billing errors should fail fast - they won't succeed on retry without adding credits
 * Checks both status code and error message patterns
 */
export function isBillingError(error: any): boolean {
	// Check for status code 402
	if (error?.status === 402 || error?.statusCode === 402) {
		return true
	}
	
	// Check error message for billing/credits error indicators
	const errorMessage = error?.message || error?.error?.message || String(error || "")
	if (errorMessage && typeof errorMessage === "string") {
		return /402|insufficient credits|insufficient balance|payment required|billing|credits|account.*never purchased/i.test(errorMessage)
	}
	
	return false
}

interface RateLimitState {
	/** When the rate limit window resets (timestamp in ms) */
	resetTime: number
	/** Whether we're currently rate limited */
	isRateLimited: boolean
	/** Number of consecutive rate limit errors */
	consecutiveErrors: number
	/** Last time we updated this state */
	lastUpdate: number
}

interface RateLimitInfo {
	/** Reset time in seconds (from Retry-After header or error message) */
	resetAfterSeconds?: number
	/** Reset time as timestamp (from x-ratelimit-reset header) */
	resetTimestamp?: number
	/** Error message that might contain reset info */
	errorMessage?: string
}

// Global state: provider + model -> rate limit state
const rateLimitState = new Map<string, RateLimitState>()

// Mutex to ensure thread-safe access
class Mutex {
	private locked = false
	private queue: Array<() => void> = []

	async acquire(): Promise<() => void> {
		return new Promise((resolve) => {
			if (!this.locked) {
				this.locked = true
				resolve(() => {
					this.locked = false
					if (this.queue.length > 0) {
						const next = this.queue.shift()!
						next()
					}
				})
			} else {
				this.queue.push(() => {
					this.locked = true
					resolve(() => {
						this.locked = false
						if (this.queue.length > 0) {
							const next = this.queue.shift()!
							next()
						}
					})
				})
			}
		})
	}
}

const mutex = new Mutex()

/**
 * Get a key for rate limit state (provider + model)
 */
function getStateKey(provider: string, modelId: string): string {
	return `${provider}:${modelId}`
}

/**
 * Extract rate limit reset time from error response
 */
function extractRateLimitInfo(error: any): RateLimitInfo {
	const info: RateLimitInfo = {}

	// Try to extract from headers (if available)
	if (error.headers) {
		// Retry-After header (seconds until reset)
		const retryAfter = error.headers.get?.("retry-after") || error.headers["retry-after"]
		if (retryAfter) {
			const seconds = parseFloat(retryAfter)
			if (!isNaN(seconds) && seconds > 0) {
				info.resetAfterSeconds = seconds
				return info // Headers take priority
			}
		}

		// x-ratelimit-reset header (timestamp)
		const resetHeader = error.headers.get?.("x-ratelimit-reset") || error.headers["x-ratelimit-reset"]
		if (resetHeader) {
			const timestamp = parseInt(resetHeader, 10)
			if (!isNaN(timestamp) && timestamp > 0) {
				info.resetTimestamp = timestamp * 1000 // Convert to ms
				return info // Headers take priority
			}
		}
	}

	// Try to extract from error message (common patterns)
	// Check multiple possible locations for the error message
	const errorMessages: string[] = []
	if (error.message) errorMessages.push(error.message)
	if (error.error?.message) errorMessages.push(error.error.message)
	if (error.error?.error?.message) errorMessages.push(error.error.error.message)
	if (typeof error === "string") errorMessages.push(error)
	
	// Also check if error itself is an Error object with a message
	if (error instanceof Error && error.message) {
		errorMessages.push(error.message)
	}

	for (const errorMsg of errorMessages) {
		if (!errorMsg || typeof errorMsg !== "string") continue
		
		info.errorMessage = errorMsg

		// Pattern: "try again in Xms" or "try again in X ms" (milliseconds)
		const retryMsMatch = errorMsg.match(/try again in ([\d.]+)\s*ms/i)
		if (retryMsMatch && retryMsMatch[1]) {
			const milliseconds = parseFloat(retryMsMatch[1])
			if (!isNaN(milliseconds) && milliseconds > 0) {
				// Convert milliseconds to seconds
				info.resetAfterSeconds = milliseconds / 1000
				break // Found it, stop searching
			}
		}

		// Pattern: "retry after Xms" or "retry after X ms" (milliseconds)
		const retryAfterMsMatch = errorMsg.match(/retry after ([\d.]+)\s*ms/i)
		if (retryAfterMsMatch && retryAfterMsMatch[1]) {
			const milliseconds = parseFloat(retryAfterMsMatch[1])
			if (!isNaN(milliseconds) && milliseconds > 0) {
				// Convert milliseconds to seconds
				info.resetAfterSeconds = milliseconds / 1000
				break // Found it, stop searching
			}
		}

		// Pattern: "wait Xms" or "wait X ms" (milliseconds)
		const waitMsMatch = errorMsg.match(/wait ([\d.]+)\s*ms/i)
		if (waitMsMatch && waitMsMatch[1]) {
			const milliseconds = parseFloat(waitMsMatch[1])
			if (!isNaN(milliseconds) && milliseconds > 0) {
				// Convert milliseconds to seconds
				info.resetAfterSeconds = milliseconds / 1000
				break // Found it, stop searching
			}
		}

		// Pattern: "Please try again in X.XXs" or "retry after X seconds"
		// Simple pattern that matches "try again in 1.122s" (tested and working)
		const retryMatch = errorMsg.match(/try again in ([\d.]+)s/i)
		if (retryMatch && retryMatch[1]) {
			const seconds = parseFloat(retryMatch[1])
			if (!isNaN(seconds) && seconds > 0) {
				// Use exact value - we'll add 1 second buffer in recordRateLimitError
				info.resetAfterSeconds = seconds
				break // Found it, stop searching
			}
		}
		
		// Also try "retry after X seconds" pattern
		const retryAfterMatch = errorMsg.match(/retry after ([\d.]+)\s*seconds?/i)
		if (retryAfterMatch && retryAfterMatch[1]) {
			const seconds = parseFloat(retryAfterMatch[1])
			if (!isNaN(seconds) && seconds > 0) {
				info.resetAfterSeconds = seconds
				break // Found it, stop searching
			}
		}

		// Pattern: "Rate limit reset at timestamp" or similar
		const timestampMatch = errorMsg.match(/reset (?:at|in) (\d+)/i)
		if (timestampMatch) {
			const timestamp = parseInt(timestampMatch[1], 10)
			if (!isNaN(timestamp) && timestamp > 0) {
				info.resetTimestamp = timestamp * 1000
				break // Found it, stop searching
			}
		}
	}

	// Try to extract from error body (JSON)
	if (error.body || error.error) {
		const body = error.body || error.error
		if (typeof body === "string") {
			try {
				const parsed = JSON.parse(body)
				if (parsed.retry_after) {
					// Check if it's in milliseconds (>= 1000) or seconds
					const retryValue = parseFloat(parsed.retry_after)
					if (!isNaN(retryValue) && retryValue > 0) {
						// If value is >= 1000, assume milliseconds; otherwise assume seconds
						info.resetAfterSeconds = retryValue >= 1000 ? retryValue / 1000 : retryValue
					}
				}
				if (parsed.retry_after_ms) {
					// Explicit milliseconds field
					const milliseconds = parseFloat(parsed.retry_after_ms)
					if (!isNaN(milliseconds) && milliseconds > 0) {
						info.resetAfterSeconds = milliseconds / 1000
					}
				}
				if (parsed.reset_at) {
					info.resetTimestamp = parseInt(parsed.reset_at, 10) * 1000
				}
			} catch {
				// Not JSON, ignore
			}
		} else if (typeof body === "object" && body !== null) {
			if (body.retry_after) {
				// Check if it's in milliseconds (>= 1000) or seconds
				const retryValue = parseFloat(body.retry_after)
				if (!isNaN(retryValue) && retryValue > 0) {
					// If value is >= 1000, assume milliseconds; otherwise assume seconds
					info.resetAfterSeconds = retryValue >= 1000 ? retryValue / 1000 : retryValue
				}
			}
			if (body.retry_after_ms) {
				// Explicit milliseconds field
				const milliseconds = parseFloat(body.retry_after_ms)
				if (!isNaN(milliseconds) && milliseconds > 0) {
					info.resetAfterSeconds = milliseconds / 1000
				}
			}
			if (body.reset_at) {
				info.resetTimestamp = parseInt(body.reset_at, 10) * 1000
			}
		}
	}

	return info
}

/**
 * Record a rate limit error and update global state
 */
export async function recordRateLimitError(
	provider: string,
	modelId: string,
	error: any,
): Promise<void> {
	const release = await mutex.acquire()
	try {
		const key = getStateKey(provider, modelId)
		const now = Date.now()
		const info = extractRateLimitInfo(error)

		let resetTime: number

		if (info.resetTimestamp) {
			// Use explicit reset timestamp (API told us exactly when)
			resetTime = info.resetTimestamp
			console.log(`[RateLimitCoordinator] Using reset timestamp: ${new Date(resetTime).toISOString()}`)
		} else if (info.resetAfterSeconds) {
			// Use Retry-After seconds (API told us exactly how long to wait)
			// Add 0.5 second buffer to account for clock skew and processing time
			// Round up to nearest second (e.g., 1.122s -> wait 2s total)
			const waitSeconds = Math.ceil(info.resetAfterSeconds + 0.5)
			resetTime = now + waitSeconds * 1000
			console.log(`[RateLimitCoordinator] Extracted ${info.resetAfterSeconds}s from error, waiting ${waitSeconds}s (from message: ${info.errorMessage?.substring(0, 100)})`)
		} else {
			// Default: wait 60 seconds (typical TPM window) - only used if API doesn't specify
			resetTime = now + 60000
			console.warn(`[RateLimitCoordinator] No reset time found in error, using default 60s. Error structure:`, {
				hasMessage: !!error.message,
				hasError: !!error.error,
				errorMessage: error.message?.substring(0, 200),
				errorErrorMessage: error.error?.message?.substring(0, 200),
			})
		}

		const existing = rateLimitState.get(key)
		const consecutiveErrors = existing ? existing.consecutiveErrors + 1 : 1

		rateLimitState.set(key, {
			resetTime,
			isRateLimited: true,
			consecutiveErrors,
			lastUpdate: now,
		})
	} finally {
		release()
	}
}

/**
 * Get the delay needed before making the next request (in milliseconds)
 * Returns 0 if no delay is needed
 */
export async function getRateLimitDelay(provider: string, modelId: string): Promise<number> {
	const release = await mutex.acquire()
	try {
		const key = getStateKey(provider, modelId)
		const state = rateLimitState.get(key)

		if (!state || !state.isRateLimited) {
			return 0
		}

		const now = Date.now()
		const resetTime = state.resetTime

		// If reset time has passed, clear the rate limit
		if (now >= resetTime) {
			rateLimitState.delete(key)
			return 0
		}

		// Return delay until reset
		return resetTime - now
	} finally {
		release()
	}
}

/**
 * Wait for rate limit to clear before proceeding
 */
export async function waitForRateLimit(provider: string, modelId: string): Promise<void> {
	const delay = await getRateLimitDelay(provider, modelId)
	if (delay > 0) {
		await new Promise((resolve) => setTimeout(resolve, delay))
		// Clear the rate limit state after waiting
		const release = await mutex.acquire()
		try {
			const key = getStateKey(provider, modelId)
			rateLimitState.delete(key)
		} finally {
			release()
		}
	}
}

/**
 * Clear rate limit state (e.g., after successful request)
 */
export async function clearRateLimit(provider: string, modelId: string): Promise<void> {
	const release = await mutex.acquire()
	try {
		const key = getStateKey(provider, modelId)
		const state = rateLimitState.get(key)

		// Only clear if we haven't hit consecutive errors
		// If we have, keep the state but reduce consecutive count
		if (state) {
			if (state.consecutiveErrors <= 1) {
				rateLimitState.delete(key)
			} else {
				// Reduce consecutive errors but keep rate limit state
				rateLimitState.set(key, {
					...state,
					consecutiveErrors: Math.max(0, state.consecutiveErrors - 1),
				})
			}
		}
	} finally {
		release()
	}
}

/**
 * Check if we're currently rate limited
 */
export async function isRateLimited(provider: string, modelId: string): Promise<boolean> {
	const delay = await getRateLimitDelay(provider, modelId)
	return delay > 0
}
