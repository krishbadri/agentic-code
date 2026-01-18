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
	| "ACTION_BLOCKED"

export class CPError extends Error {
	public code: ErrorCode
	public details?: Record<string, unknown>

	constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
		super(message)
		this.code = code
		this.details = details
	}
}

export const errorResponse = (e: unknown) => {
	if (e instanceof CPError) {
		// Preserve details exactly as provided (do not rename keys)
		// Spread details into response to preserve all keys exactly
		return { code: e.code, message: e.message, ...(e.details && { ...e.details }) }
	}
	return { code: "DENIED" as ErrorCode, message: e instanceof Error ? e.message : String(e) }
}
