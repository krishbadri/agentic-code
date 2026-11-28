export type ErrorCode =
	| "CONFLICT_BASE_ADVANCED"
	| "REBASE_CONFLICT"
	| "BAD_PATCH"
	| "TIMEOUT"
	| "DENIED"
	| "PATCH_REJECTED"
	| "TEST_FILE_PROTECTED"
	| "PROGRESS_VIOLATION"
	| "MERGE_CONFLICT"
	| "LIVENESS_FAILED"
	| "LIVENESS_UNCONFIGURED"
	| "ACTION_BLOCKED"
	| "VALIDATION_ERROR"
	| "TX_NOT_FOUND"
	| "SUB_TX_NOT_FOUND"
	| "TX_NOT_ACTIVE"
	| "NOT_IMPLEMENTED"
	| "STRUCTURAL_CONFLICT"
	| "TEST_COMMAND_INVALID"
	| "REPLAY_UNSUPPORTED"
	| "REPLAY_PARTIAL"
	| "WORKSPACE_DIRTY"
	| "FILE_EXISTS"
	| "FILE_ALREADY_RESERVED"
	| "INTERNAL_ERROR"

export class CPError extends Error {
	public code: ErrorCode
	public details?: Record<string, unknown>

	constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
		super(message)
		this.code = code
		this.details = details
	}
}

/**
 * Map an error code to its HTTP status. Used by the global error handler so
 * that a CPError thrown anywhere in a route produces a consistent response.
 */
export function httpStatusFor(code: ErrorCode): number {
	switch (code) {
		case "VALIDATION_ERROR":
		// DENIED is thrown by path-safety checks (traversal, absolute, symlink): bad input
		case "DENIED":
		case "BAD_PATCH":
		case "PATCH_REJECTED":
		case "TEST_COMMAND_INVALID":
			return 400
		case "ACTION_BLOCKED":
		case "TEST_FILE_PROTECTED":
		case "PROGRESS_VIOLATION":
		case "LIVENESS_FAILED":
			return 403
		case "TX_NOT_FOUND":
		case "SUB_TX_NOT_FOUND":
			return 404
		case "CONFLICT_BASE_ADVANCED":
		case "REBASE_CONFLICT":
		case "MERGE_CONFLICT":
		case "STRUCTURAL_CONFLICT":
		case "TX_NOT_ACTIVE":
		case "WORKSPACE_DIRTY":
		case "FILE_EXISTS":
		case "FILE_ALREADY_RESERVED":
			return 409
		case "LIVENESS_UNCONFIGURED":
			return 412
		case "REPLAY_PARTIAL":
			return 422
		case "NOT_IMPLEMENTED":
		case "REPLAY_UNSUPPORTED":
			return 501
		case "TIMEOUT":
			return 504
		default:
			return 500
	}
}

/** Duck-typed ZodError check (avoids importing zod here). */
export function isZodError(e: unknown): e is { issues: unknown[]; message: string } {
	return !!e && typeof e === "object" && (e as any).name === "ZodError" && Array.isArray((e as any).issues)
}

/**
 * Status + body for any thrown value: CPError → mapped status, ZodError → 400,
 * anything else → `fallbackStatus` (500 by default).
 */
export function errorStatusAndBody(
	e: unknown,
	fallbackStatus = 500,
): { status: number; body: Record<string, unknown> } {
	if (e instanceof CPError) {
		return { status: httpStatusFor(e.code), body: errorResponse(e) }
	}
	if (isZodError(e)) {
		return {
			status: 400,
			body: { code: "VALIDATION_ERROR", message: "Request validation failed", issues: e.issues },
		}
	}
	return { status: fallbackStatus, body: errorResponse(e) }
}

/** Send an error reply with the correct status. */
export function sendError(reply: { code(n: number): { send(b: unknown): unknown } }, e: unknown, fallbackStatus = 500) {
	const { status, body } = errorStatusAndBody(e, fallbackStatus)
	return reply.code(status).send(body)
}

export const errorResponse = (e: unknown) => {
	if (e instanceof CPError) {
		// Preserve details exactly as provided (do not rename keys)
		return { code: e.code, message: e.message, ...(e.details && { ...e.details }) }
	}
	return { code: "INTERNAL_ERROR" as ErrorCode, message: e instanceof Error ? e.message : String(e) }
}
