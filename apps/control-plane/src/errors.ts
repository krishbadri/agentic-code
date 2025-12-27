export type ErrorCode = "CONFLICT_BASE_ADVANCED" | "REBASE_CONFLICT" | "BAD_PATCH" | "TIMEOUT" | "DENIED"

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
		return { code: e.code, message: e.message, details: e.details }
	}
	return { code: "DENIED" as ErrorCode, message: e instanceof Error ? e.message : String(e) }
}
