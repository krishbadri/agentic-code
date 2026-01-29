import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import { maybeVcrWrapStream, type VcrRequestDescriptor } from "../recordReplay"
import { getVcrConfig } from "../vcrConfig"
import { getVcrFilePath } from "../key"

describe("VCR Integration", () => {
	let tempDir: string
	let originalMode: string | undefined
	let originalDir: string | undefined

	beforeEach(async () => {
		// VERIFICATION-ONLY: Use provided ROO_VCR_DIR if set, otherwise create temp dir
		// This allows external verification scripts to specify a directory to inspect
		if (process.env.ROO_VCR_DIR) {
			tempDir = process.env.ROO_VCR_DIR
		} else {
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vcr-test-"))
		}
		originalMode = process.env.ROO_VCR_MODE
		originalDir = process.env.ROO_VCR_DIR
		process.env.ROO_VCR_MODE = "record"
		process.env.ROO_VCR_DIR = tempDir
	})

	afterEach(async () => {
		// Restore environment
		if (originalMode !== undefined) {
			process.env.ROO_VCR_MODE = originalMode
		} else {
			delete process.env.ROO_VCR_MODE
		}
		if (originalDir !== undefined) {
			process.env.ROO_VCR_DIR = originalDir
		} else {
			delete process.env.ROO_VCR_DIR
		}

		// VERIFICATION-ONLY: Skip cleanup if ROO_VCR_KEEP_FIXTURES=1
		// This allows external verification scripts to inspect fixtures on disk
		if (process.env.ROO_VCR_KEEP_FIXTURES === "1") {
			return
		}

		// Cleanup temp directory
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch {
			// Ignore cleanup errors
		}
	})

	describe("OpenAI-style stream", () => {
		it("should record and replay OpenAI-style chunks", async () => {
			// Assert record mode is set
			expect(getVcrConfig().mode).toBe("record")

			const descriptor: VcrRequestDescriptor = {
				providerName: "openai",
				model: "gpt-4",
				endpoint: "openai-chat",
				params: {
					messages: [{ role: "user", content: "Hello" }],
					temperature: 0.7,
				},
			}

			// Create fake OpenAI-style stream
			async function* fakeOpenAIStream() {
				yield {
					choices: [{ delta: { content: "Hello" }, index: 0 }],
					usage: null,
				}
				yield {
					choices: [{ delta: { content: " world" }, index: 0 }],
					usage: null,
				}
				yield {
					choices: [{ delta: {}, index: 0 }],
					usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
				}
			}

			// Record
			const recorded = await maybeVcrWrapStream(descriptor, fakeOpenAIStream())
			const recordedChunks: unknown[] = []
			for await (const chunk of recorded) {
				recordedChunks.push(chunk)
			}

			expect(recordedChunks).toHaveLength(3)

			// Assert fixture file was created
			const expectedFilePath = getVcrFilePath(tempDir, descriptor.providerName, descriptor.model, descriptor)
			await expect(fs.access(expectedFilePath)).resolves.toBeUndefined()

			// Switch to replay mode
			process.env.ROO_VCR_MODE = "replay"
			expect(getVcrConfig().mode).toBe("replay")

			// Replay
			const replayed = await maybeVcrWrapStream(descriptor, fakeOpenAIStream())
			const replayedChunks: unknown[] = []
			for await (const chunk of replayed) {
				replayedChunks.push(chunk)
			}

			// Should match exactly
			expect(replayedChunks).toEqual(recordedChunks)
			expect(replayedChunks).toHaveLength(3)
		})
	})

	describe("Anthropic-style stream", () => {
		it("should record and replay Anthropic-style events", async () => {
			// Assert record mode is set
			expect(getVcrConfig().mode).toBe("record")

			const descriptor: VcrRequestDescriptor = {
				providerName: "anthropic",
				model: "claude-3-opus",
				endpoint: "anthropic-messages",
				params: {
					messages: [{ role: "user", content: "Hi" }],
					max_tokens: 100,
				},
			}

			// Create fake Anthropic-style stream
			async function* fakeAnthropicStream() {
				yield {
					type: "message_start",
					message: { id: "msg-1", usage: { input_tokens: 5, output_tokens: 0 } },
				}
				yield {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}
				yield {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Hello" },
				}
				yield {
					type: "content_block_stop",
					index: 0,
				}
				yield {
					type: "message_stop",
				}
			}

			// Record
			const recorded = await maybeVcrWrapStream(descriptor, fakeAnthropicStream())
			const recordedChunks: unknown[] = []
			for await (const chunk of recorded) {
				recordedChunks.push(chunk)
			}

			expect(recordedChunks).toHaveLength(5)

			// Assert fixture file was created
			const expectedFilePath = getVcrFilePath(tempDir, descriptor.providerName, descriptor.model, descriptor)
			await expect(fs.access(expectedFilePath)).resolves.toBeUndefined()

			// Switch to replay mode
			process.env.ROO_VCR_MODE = "replay"
			expect(getVcrConfig().mode).toBe("replay")

			// Replay
			const replayed = await maybeVcrWrapStream(descriptor, fakeAnthropicStream())
			const replayedChunks: unknown[] = []
			for await (const chunk of replayed) {
				replayedChunks.push(chunk)
			}

			// Should match exactly
			expect(replayedChunks).toEqual(recordedChunks)
			expect(replayedChunks).toHaveLength(5)
		})
	})

	describe("Error handling", () => {
		it("should throw clear error when replay file is missing", async () => {
			process.env.ROO_VCR_MODE = "replay"
			expect(getVcrConfig().mode).toBe("replay")

			const descriptor: VcrRequestDescriptor = {
				providerName: "openai",
				model: "gpt-4",
				endpoint: "openai-chat",
				params: { messages: [{ role: "user", content: "Test" }] },
			}

			// Ensure fixture file does not exist
			const expectedFilePath = getVcrFilePath(tempDir, descriptor.providerName, descriptor.model, descriptor)
			try {
				await fs.unlink(expectedFilePath)
			} catch {
				// File doesn't exist, which is what we want
			}

			async function* fakeStream() {
				yield { test: "data" }
			}

			await expect(async () => {
				const replayed = await maybeVcrWrapStream(descriptor, fakeStream())
				for await (const _chunk of replayed) {
					// Consume stream
				}
			}).rejects.toThrow(/Recording not found/)

			// Now create the fixture and verify replay works
			process.env.ROO_VCR_MODE = "record"
			const recorded = await maybeVcrWrapStream(descriptor, fakeStream())
			for await (const _chunk of recorded) {
				// Consume stream to trigger recording
			}

			// Verify file exists
			await expect(fs.access(expectedFilePath)).resolves.toBeUndefined()

			// Switch back to replay and verify it works
			process.env.ROO_VCR_MODE = "replay"
			const replayed = await maybeVcrWrapStream(descriptor, fakeStream())
			const replayedChunks: unknown[] = []
			for await (const chunk of replayed) {
				replayedChunks.push(chunk)
			}

			expect(replayedChunks).toEqual([{ test: "data" }])
		})
	})

	describe("Off mode", () => {
		it("should pass through stream unchanged when VCR is off", async () => {
			process.env.ROO_VCR_MODE = "off"
			expect(getVcrConfig().mode).toBe("off")

			const descriptor: VcrRequestDescriptor = {
				providerName: "openai",
				model: "gpt-4",
				endpoint: "openai-chat",
				params: { messages: [] },
			}

			const chunks: unknown[] = []
			async function* fakeStream() {
				yield { a: 1 }
				yield { b: 2 }
			}

			const wrapped = await maybeVcrWrapStream(descriptor, fakeStream())
			for await (const chunk of wrapped) {
				chunks.push(chunk)
			}

			expect(chunks).toEqual([{ a: 1 }, { b: 2 }])

			// Verify no fixture file was created
			const expectedFilePath = getVcrFilePath(tempDir, descriptor.providerName, descriptor.model, descriptor)
			await expect(fs.access(expectedFilePath)).rejects.toThrow()
		})
	})
})
