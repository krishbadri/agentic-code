/**
 * Scripted OpenAI-compatible model for end-to-end tests.
 *
 * The extension is pointed at this server (`openAiBaseUrl`), so the whole real
 * stack runs — extension host, tool execution, Control-Plane, git — with a
 * deterministic "model" and no API key.
 *
 * Routing:
 *  - planner requests (system prompt starts with "You are a planning agent")
 *    answer with the plan registered for the `[[scenario:NAME]]` marker;
 *  - agent requests answer with turn N of the script registered for the
 *    `[[step:NAME]]` marker (planner children) or `[[scenario:NAME]]` marker,
 *    where N is the number of assistant messages already in the conversation.
 *
 * Every request is recorded so tests can assert on what the model was told
 * (tool results, block reasons, working directory).
 */
import * as http from "http"
import type { AddressInfo } from "net"

export interface RecordedRequest {
	kind: "planner" | "agent"
	key: string
	turn: number
	/** Text of the last user message (tool results + environment details). */
	lastUser: string
	/** Whole request body as text (system prompt included). */
	raw: string
	at: number
}

export type Turn = string | ((req: RecordedRequest) => string | Promise<string>)

export interface MockLlm {
	url: string
	requests: RecordedRequest[]
	/** Register the agent script for a `scenario:NAME` / `step:NAME` key. */
	script(key: string, turns: Turn[]): void
	/** Register the planner's answer for a scenario (omit for an empty plan). */
	plan(scenario: string, plan: unknown): void
	requestsFor(key: string): RecordedRequest[]
	close(): Promise<void>
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
			.join("\n")
	}
	return ""
}

function lastMarker(text: string, kind: "scenario" | "step"): string | undefined {
	const re = new RegExp(`\\[\\[${kind}:([a-z0-9_-]+)\\]\\]`, "gi")
	let m: RegExpExecArray | null
	let found: string | undefined
	while ((m = re.exec(text))) found = m[1]
	return found
}

export async function startMockLlm(): Promise<MockLlm> {
	const scripts = new Map<string, Turn[]>()
	const plans = new Map<string, unknown>()
	const requests: RecordedRequest[] = []

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on("data", (c) => chunks.push(c))
		req.on("end", async () => {
			try {
				if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
					res.writeHead(404, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: { message: `mock-llm: no route ${req.method} ${req.url}` } }))
					return
				}
				const raw = Buffer.concat(chunks).toString("utf8")
				const body = JSON.parse(raw)
				const messages: Array<{ role: string; content: unknown }> = body.messages ?? []
				const system = messages
					.filter((m) => m.role === "system" || m.role === "developer")
					.map((m) => textOf(m.content))
					.join("\n")
				const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content))
				const firstUser = users[0] ?? ""
				const lastUser = users[users.length - 1] ?? ""
				const turn = messages.filter((m) => m.role === "assistant").length

				let answer: string
				const isPlanner = system.trimStart().startsWith("You are a planning agent")
				if (isPlanner) {
					// The marker sits on the "Task: ..." line of the planner prompt.
					const scenario = lastMarker(firstUser.split("IMPORTANT:")[0] ?? firstUser, "scenario") ?? "?"
					const rec: RecordedRequest = {
						kind: "planner",
						key: `scenario:${scenario}`,
						turn,
						lastUser,
						raw,
						at: Date.now(),
					}
					requests.push(rec)
					answer = JSON.stringify(plans.get(scenario) ?? { subTransactions: [] })
				} else {
					const step = lastMarker(firstUser, "step")
					const scenario = lastMarker(firstUser, "scenario")
					const key = step ? `step:${step}` : `scenario:${scenario ?? "?"}`
					const rec: RecordedRequest = { kind: "agent", key, turn, lastUser, raw, at: Date.now() }
					requests.push(rec)
					const turns = scripts.get(key)
					if (!turns || turns.length === 0) {
						answer = `<attempt_completion>\n<result>\nmock-llm: no script registered for ${key}\n</result>\n</attempt_completion>`
					} else {
						const t = turns[Math.min(turn, turns.length - 1)]!
						answer = typeof t === "function" ? await t(rec) : t
					}
				}

				const id = `chatcmpl-mock-${requests.length}`
				const created = Math.floor(Date.now() / 1000)
				const model = body.model ?? "mock-model"
				const usage = {
					prompt_tokens: Math.ceil(raw.length / 4),
					completion_tokens: Math.ceil(answer.length / 4),
					total_tokens: Math.ceil((raw.length + answer.length) / 4),
				}

				if (body.stream) {
					res.writeHead(200, {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
					})
					const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
					const base = { id, object: "chat.completion.chunk", created, model }
					send({
						...base,
						choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
					})
					// Stream in a few pieces so partial-tool parsing is exercised too.
					const size = Math.max(40, Math.ceil(answer.length / 6))
					for (let i = 0; i < answer.length; i += size) {
						send({
							...base,
							choices: [{ index: 0, delta: { content: answer.slice(i, i + size) }, finish_reason: null }],
						})
					}
					send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
					send({ ...base, choices: [], usage })
					res.write("data: [DONE]\n\n")
					res.end()
				} else {
					res.writeHead(200, { "content-type": "application/json" })
					res.end(
						JSON.stringify({
							id,
							object: "chat.completion",
							created,
							model,
							choices: [
								{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
							],
							usage,
						}),
					)
				}
			} catch (e) {
				res.writeHead(500, { "content-type": "application/json" })
				res.end(
					JSON.stringify({ error: { message: `mock-llm: ${e instanceof Error ? e.message : String(e)}` } }),
				)
			}
		})
	})

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const port = (server.address() as AddressInfo).port

	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		script: (key, turns) => void scripts.set(key, turns),
		plan: (scenario, plan) => void plans.set(scenario, plan),
		requestsFor: (key) => requests.filter((r) => r.key === key),
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

// ── helpers for writing scripts ─────────────────────────────────────────────

export const tool = {
	write: (path: string, content: string) =>
		`<write_to_file>\n<path>${path}</path>\n<content>\n${content}\n</content>\n<line_count>${
			content.split("\n").length
		}</line_count>\n</write_to_file>`,
	exec: (command: string) => `<execute_command>\n<command>${command}</command>\n</execute_command>`,
	done: (result: string) => `<attempt_completion>\n<result>\n${result}\n</result>\n</attempt_completion>`,
}
