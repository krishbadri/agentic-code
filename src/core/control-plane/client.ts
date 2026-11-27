import * as vscode from "vscode"

/**
 * Shared Control-Plane (CP) client.
 *
 * Every extension → CP HTTP call goes through `cpRequest()` so that:
 *  - the actor header, JSON encoding and timeouts are uniform;
 *  - network failures / timeouts surface as `ControlPlaneUnavailableError`
 *    (callers decide whether to fail closed), while HTTP errors are returned
 *    as `{ ok: false, status, data }` with the CP's `{ code, message }` body.
 */

export const CP_MIN_API_VERSION = 2
export const CP_ACTOR_ID = "human"
export const DEFAULT_CP_TIMEOUT_MS = 15_000

export class ControlPlaneUnavailableError extends Error {
	override readonly name = "ControlPlaneUnavailableError"
	constructor(
		message: string,
		public override readonly cause?: unknown,
	) {
		super(message)
	}
}

export function isControlPlaneUnavailableError(err: unknown): err is ControlPlaneUnavailableError {
	return (
		err instanceof ControlPlaneUnavailableError ||
		(typeof err === "object" && err !== null && (err as any).name === "ControlPlaneUnavailableError")
	)
}

/** Standard CP error body. */
export interface CpErrorBody {
	code?: string
	message?: string
	[key: string]: unknown
}

export interface CpResponse<T = any> {
	status: number
	ok: boolean
	data: T
}

// ── Settings ────────────────────────────────────────────────────────────────

export type ConfigLike = {
	get(key: string, defaultValue?: any): any
	inspect?(key: string):
		| {
				defaultValue?: unknown
				globalValue?: unknown
				workspaceValue?: unknown
				workspaceFolderValue?: unknown
		  }
		| undefined
}

/**
 * Read a boolean setting that may be set under several alias keys.
 *
 * Uses `cfg.inspect()` so that an explicit `false` anywhere wins over a default
 * `true` on an alias (the old `a || b` pattern made it impossible to turn a
 * setting off). Precedence: the most specific scope that has an explicit value
 * on ANY alias (workspaceFolder > workspace > global); within one scope the
 * first key in `keys` wins. Falls back to the first key's contributed default,
 * then `fallback`.
 */
export function readBooleanSetting(
	keys: string[],
	fallback: boolean,
	cfg: ConfigLike = vscode.workspace.getConfiguration() as unknown as ConfigLike,
): boolean {
	if (typeof cfg.inspect === "function") {
		const inspected = keys.map((k) => cfg.inspect!(k))
		for (const scope of ["workspaceFolderValue", "workspaceValue", "globalValue"] as const) {
			for (const info of inspected) {
				const v = info?.[scope]
				if (typeof v === "boolean") return v
			}
		}
		for (const info of inspected) {
			if (typeof info?.defaultValue === "boolean") return info.defaultValue
		}
		return fallback
	}

	// Test doubles / minimal configs without inspect(): first boolean wins.
	for (const k of keys) {
		const v = cfg.get(k)
		if (typeof v === "boolean") return v
	}
	return fallback
}

export function isTransactionalModeEnabled(cfg?: ConfigLike): boolean {
	return readBooleanSetting(
		["roo.experimental.transactionalMode", "roo-cline.experimental.transactionalMode"],
		true,
		cfg,
	)
}

export function isPlannerModeEnabled(cfg?: ConfigLike): boolean {
	return readBooleanSetting(["roo.experimental.plannerMode", "roo-cline.experimental.plannerMode"], true, cfg)
}

export function getCommitStrategy(cfg?: ConfigLike): "rebase" | "fail-fast" | "hybrid" {
	const c = cfg ?? (vscode.workspace.getConfiguration() as unknown as ConfigLike)
	const v = c.get("roo.commit.strategy")
	return v === "fail-fast" || v === "hybrid" || v === "rebase" ? v : "rebase"
}

export function getConfiguredTestCommand(cfg?: ConfigLike): string | undefined {
	const c = cfg ?? (vscode.workspace.getConfiguration() as unknown as ConfigLike)
	const v = c.get("roo.controlPlane.testCommand")
	return typeof v === "string" && v.trim() ? v.trim() : undefined
}

// ── Port / readiness ────────────────────────────────────────────────────────

type ContextLike = { globalState?: { get<T>(key: string): T | undefined } } | undefined

export function getCpPort(context: ContextLike): number | undefined {
	const override = (() => {
		try {
			return vscode.workspace.getConfiguration().get<number>("roo.cpPortOverride")
		} catch {
			return undefined
		}
	})()
	if (typeof override === "number" && override > 0) return override
	const port = context?.globalState?.get<number>("roo.cpPort")
	return typeof port === "number" && port > 0 ? port : undefined
}

let controlPlaneReadyPromise: Promise<number | undefined> | undefined

/** Called by extension activation with the auto-start promise. */
export function setControlPlaneReady(p: Promise<number | undefined> | undefined): void {
	controlPlaneReadyPromise = p
}

export function getControlPlaneReady(): Promise<number | undefined> | undefined {
	return controlPlaneReadyPromise
}

/**
 * Resolve a healthy CP port, waiting for the auto-start promise if it is still
 * pending. Returns `undefined` when transactional mode is off or the CP is not
 * available (callers then run single-agent with a visible warning).
 */
export async function waitForControlPlane(
	context: ContextLike,
	{ timeoutMs = 90_000 }: { timeoutMs?: number } = {},
): Promise<number | undefined> {
	if (!isTransactionalModeEnabled()) return undefined

	if (controlPlaneReadyPromise) {
		let timer: NodeJS.Timeout | undefined
		try {
			await Promise.race([
				controlPlaneReadyPromise.catch(() => undefined),
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), timeoutMs)
				}),
			])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	const port = getCpPort(context)
	if (!port) return undefined
	return (await isCpHealthy(port)) ? port : undefined
}

// ── HTTP ────────────────────────────────────────────────────────────────────

export interface CpRequestOptions {
	timeoutMs?: number
	actorId?: string
}

export function cpBaseUrl(port: number): string {
	return `http://127.0.0.1:${port}`
}

/**
 * Perform a CP request. Resolves with `{status, ok, data}` for every HTTP
 * response (including 4xx/5xx). Throws `ControlPlaneUnavailableError` only on
 * network failure or timeout.
 */
export async function cpRequest<T = any>(
	port: number,
	method: "GET" | "POST" | "DELETE",
	path: string,
	body?: unknown,
	{ timeoutMs = DEFAULT_CP_TIMEOUT_MS, actorId = CP_ACTOR_ID }: CpRequestOptions = {},
): Promise<CpResponse<T>> {
	if (!port) {
		throw new ControlPlaneUnavailableError("Control-Plane port is not set")
	}
	const url = `${cpBaseUrl(port)}${path}`
	let res: Response
	try {
		res = await fetch(url, {
			method,
			headers: {
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				"X-Actor-Id": actorId,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		const isTimeout = (err as any)?.name === "TimeoutError" || (err as any)?.name === "AbortError"
		throw new ControlPlaneUnavailableError(
			isTimeout
				? `Control-Plane request timed out after ${timeoutMs}ms: ${method} ${path}`
				: `Control-Plane unreachable: ${method} ${path}: ${msg}`,
			err,
		)
	}

	let text = ""
	try {
		text = await res.text()
	} catch {
		// ignore body read errors
	}
	let data: any = undefined
	if (text) {
		try {
			data = JSON.parse(text)
		} catch {
			data = { message: text }
		}
	}
	return { status: res.status, ok: res.ok, data: (data ?? {}) as T }
}

/** Human-readable message for a non-ok CP response. */
export function cpErrorMessage(res: CpResponse<any>): string {
	const d = (res.data ?? {}) as CpErrorBody
	const code = typeof d.code === "string" ? d.code : undefined
	const message =
		typeof d.message === "string" ? d.message : typeof d.reason === "string" ? (d.reason as string) : undefined
	return [code, message].filter(Boolean).join(": ") || `HTTP ${res.status}`
}

/**
 * True when `/health` answers 2xx and reports `api >= CP_MIN_API_VERSION`.
 */
export async function isCpHealthy(port: number, timeoutMs = 2_000): Promise<boolean> {
	try {
		const res = await cpRequest<{ status?: string; api?: number }>(port, "GET", "/health", undefined, {
			timeoutMs,
		})
		if (!res.ok) return false
		const api = Number(res.data?.api ?? 0)
		return api >= CP_MIN_API_VERSION
	} catch {
		return false
	}
}
