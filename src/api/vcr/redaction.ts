/**
 * Deep redaction of sensitive fields from objects
 * 
 * Redacts any field whose key matches: /apikey|api_key|token|secret|authorization/i
 */

const SENSITIVE_KEY_PATTERN = /apikey|api_key|token|secret|authorization/i

/**
 * Check if a key should be redacted
 */
function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_PATTERN.test(key)
}

/**
 * Redact sensitive fields from an object (deep clone with redaction)
 */
export function redactSensitiveFields<T>(obj: T): T {
	if (obj === null || obj === undefined) {
		return obj
	}

	// Handle primitives
	if (typeof obj !== "object") {
		return obj
	}

	// Handle arrays
	if (Array.isArray(obj)) {
		return obj.map((item) => redactSensitiveFields(item)) as T
	}

	// Handle Date objects
	if (obj instanceof Date) {
		return obj as T
	}

	// Handle objects
	const result: any = {}
	for (const [key, value] of Object.entries(obj)) {
		if (isSensitiveKey(key)) {
			result[key] = "[REDACTED]"
		} else if (typeof value === "object" && value !== null) {
			result[key] = redactSensitiveFields(value)
		} else {
			result[key] = value
		}
	}

	return result as T
}

/**
 * Redact Authorization header from headers object
 */
export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return headers
	}

	const redacted = { ...headers }
	if ("authorization" in redacted || "Authorization" in redacted) {
		const authKey = "authorization" in redacted ? "authorization" : "Authorization"
		redacted[authKey] = "[REDACTED]"
	}

	return redacted
}
