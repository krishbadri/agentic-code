import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

import {
	readBooleanSetting,
	isTransactionalModeEnabled,
	isPlannerModeEnabled,
	cpRequest,
	isCpHealthy,
	ControlPlaneUnavailableError,
	isControlPlaneUnavailableError,
	getCpPort,
	waitForControlPlane,
	setControlPlaneReady,
	cpErrorMessage,
	getCommitStrategy,
} from "../client"

type Inspect = {
	defaultValue?: boolean
	globalValue?: boolean
	workspaceValue?: boolean
	workspaceFolderValue?: boolean
}

function cfgWith(map: Record<string, Inspect>) {
	return {
		get: (key: string) => {
			const i = map[key]
			return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue ?? i?.defaultValue
		},
		inspect: (key: string) => map[key],
	}
}

const TX = "roo.experimental.transactionalMode"
const TX_ALIAS = "roo-cline.experimental.transactionalMode"

describe("readBooleanSetting precedence", () => {
	it("uses the contributed default when nothing is set", () => {
		const cfg = cfgWith({ [TX]: { defaultValue: true }, [TX_ALIAS]: { defaultValue: true } })
		expect(isTransactionalModeEnabled(cfg)).toBe(true)
	})

	it("an explicit false on the canonical key wins over a default true alias", () => {
		const cfg = cfgWith({
			[TX]: { defaultValue: true, globalValue: false },
			[TX_ALIAS]: { defaultValue: true },
		})
		expect(isTransactionalModeEnabled(cfg)).toBe(false)
	})

	it("an explicit false on the alias key wins over a default true canonical key", () => {
		const cfg = cfgWith({
			[TX]: { defaultValue: true },
			[TX_ALIAS]: { defaultValue: true, globalValue: false },
		})
		expect(isTransactionalModeEnabled(cfg)).toBe(false)
	})

	it("workspace scope beats global scope across aliases", () => {
		const cfg = cfgWith({
			[TX]: { defaultValue: true, globalValue: false },
			[TX_ALIAS]: { defaultValue: true, workspaceValue: true },
		})
		expect(isTransactionalModeEnabled(cfg)).toBe(true)
	})

	it("workspaceFolder scope beats workspace scope", () => {
		const cfg = cfgWith({
			[TX]: { defaultValue: true, workspaceValue: true, workspaceFolderValue: false },
		})
		expect(isTransactionalModeEnabled(cfg)).toBe(false)
	})

	it("within a scope the canonical key wins", () => {
		const cfg = cfgWith({
			[TX]: { globalValue: false },
			[TX_ALIAS]: { globalValue: true },
		})
		expect(isTransactionalModeEnabled(cfg)).toBe(false)
	})

	it("falls back to the hard default when nothing is contributed", () => {
		expect(isTransactionalModeEnabled(cfgWith({}))).toBe(true)
		expect(readBooleanSetting(["x.y"], false, cfgWith({}))).toBe(false)
	})

	it("works with configs that have no inspect()", () => {
		const cfg = { get: (k: string) => (k === "roo-cline.experimental.plannerMode" ? false : undefined) }
		expect(isPlannerModeEnabled(cfg)).toBe(false)
		expect(isTransactionalModeEnabled({ get: () => undefined })).toBe(true)
	})

	it("commit strategy defaults to rebase", () => {
		expect(getCommitStrategy({ get: () => undefined })).toBe("rebase")
		expect(getCommitStrategy({ get: () => "fail-fast" } as any)).toBe("fail-fast")
		expect(getCommitStrategy({ get: () => "bogus" } as any)).toBe("rebase")
	})
})

describe("cpRequest", () => {
	const fetchMock = vi.fn()
	beforeEach(() => {
		fetchMock.mockReset()
		vi.stubGlobal("fetch", fetchMock)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("returns {status, ok, data} for 2xx and sends the actor header", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ tx_id: "t1" }), { status: 200 }))
		const res = await cpRequest(1234, "POST", "/tx/begin", { isolation: "hybrid" })
		expect(res).toEqual({ status: 200, ok: true, data: { tx_id: "t1" } })
		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe("http://127.0.0.1:1234/tx/begin")
		expect(init.method).toBe("POST")
		expect(init.headers["X-Actor-Id"]).toBe("human")
		expect(JSON.parse(init.body)).toEqual({ isolation: "hybrid" })
	})

	it("returns non-2xx responses without throwing", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ code: "LIVENESS_FAILED", message: "2 failing" }), { status: 403 }),
		)
		const res = await cpRequest(1, "POST", "/tx/a/commit", {})
		expect(res.ok).toBe(false)
		expect(res.status).toBe(403)
		expect(cpErrorMessage(res)).toBe("LIVENESS_FAILED: 2 failing")
	})

	it("wraps non-JSON bodies as {message}", async () => {
		fetchMock.mockResolvedValue(new Response("boom", { status: 500 }))
		const res = await cpRequest(1, "GET", "/x")
		expect(res).toEqual({ status: 500, ok: false, data: { message: "boom" } })
	})

	it("throws ControlPlaneUnavailableError on network failure", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"))
		await expect(cpRequest(1, "GET", "/health")).rejects.toBeInstanceOf(ControlPlaneUnavailableError)
	})

	it("throws ControlPlaneUnavailableError on timeout", async () => {
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						const e = new Error("timed out")
						e.name = "TimeoutError"
						reject(e)
					})
				}),
		)
		const err = await cpRequest(1, "GET", "/slow", undefined, { timeoutMs: 20 }).catch((e) => e)
		expect(isControlPlaneUnavailableError(err)).toBe(true)
		expect(String(err.message)).toMatch(/timed out/)
	})

	it("throws ControlPlaneUnavailableError when no port is given", async () => {
		await expect(cpRequest(0, "GET", "/health")).rejects.toBeInstanceOf(ControlPlaneUnavailableError)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe("isCpHealthy / waitForControlPlane", () => {
	const fetchMock = vi.fn()
	beforeEach(() => {
		fetchMock.mockReset()
		vi.stubGlobal("fetch", fetchMock)
		setControlPlaneReady(undefined)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		setControlPlaneReady(undefined)
	})

	it("requires api >= 2", async () => {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }))
		expect(await isCpHealthy(1)).toBe(false)
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok", api: 2 }), { status: 200 }))
		expect(await isCpHealthy(1)).toBe(true)
		fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))
		expect(await isCpHealthy(1)).toBe(false)
	})

	it("getCpPort reads roo.cpPort from global state", () => {
		expect(getCpPort({ globalState: { get: () => 4321 } as any })).toBe(4321)
		expect(getCpPort({ globalState: { get: () => undefined } as any })).toBeUndefined()
		expect(getCpPort(undefined)).toBeUndefined()
	})

	it("awaits the auto-start promise and returns a healthy port", async () => {
		let port: number | undefined
		let resolveReady!: (p: number | undefined) => void
		setControlPlaneReady(
			new Promise((r) => {
				resolveReady = r
			}),
		)
		const ctx = { globalState: { get: () => port } as any }
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "ok", api: 2 }), { status: 200 }))
		const waiting = waitForControlPlane(ctx)
		port = 5555
		resolveReady(5555)
		expect(await waiting).toBe(5555)
	})

	it("returns undefined when the CP failed to start", async () => {
		setControlPlaneReady(Promise.resolve(undefined))
		const ctx = { globalState: { get: () => undefined } as any }
		expect(await waitForControlPlane(ctx)).toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("returns undefined when the stored port is not healthy", async () => {
		const ctx = { globalState: { get: () => 7777 } as any }
		fetchMock.mockRejectedValue(new TypeError("fetch failed"))
		expect(await waitForControlPlane(ctx)).toBeUndefined()
	})
})
