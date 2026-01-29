import { describe, it, expect } from "vitest"
import { generateVcrKey, getVcrFilePath } from "../key"
import type { VcrRequestDescriptor } from "../recordReplay"

describe("VCR Key Generation", () => {
	it("should generate stable keys for identical requests", () => {
		const descriptor: VcrRequestDescriptor = {
			providerName: "openai",
			model: "gpt-4",
			endpoint: "openai-chat",
			params: {
				messages: [{ role: "user", content: "Hello" }],
				temperature: 0.7,
			},
		}

		const key1 = generateVcrKey(descriptor)
		const key2 = generateVcrKey(descriptor)

		expect(key1).toBe(key2)
		expect(key1).toHaveLength(16)
	})

	it("should generate different keys for different requests", () => {
		const descriptor1: VcrRequestDescriptor = {
			providerName: "openai",
			model: "gpt-4",
			endpoint: "openai-chat",
			params: {
				messages: [{ role: "user", content: "Hello" }],
			},
		}

		const descriptor2: VcrRequestDescriptor = {
			providerName: "openai",
			model: "gpt-4",
			endpoint: "openai-chat",
			params: {
				messages: [{ role: "user", content: "Goodbye" }],
			},
		}

		const key1 = generateVcrKey(descriptor1)
		const key2 = generateVcrKey(descriptor2)

		expect(key1).not.toBe(key2)
	})

	it("should generate same key regardless of apiKey value", () => {
		const descriptor1: VcrRequestDescriptor = {
			providerName: "openai",
			model: "gpt-4",
			endpoint: "openai-chat",
			params: {
				messages: [{ role: "user", content: "Hello" }],
				apiKey: "sk-123456",
			},
		}

		const descriptor2: VcrRequestDescriptor = {
			providerName: "openai",
			model: "gpt-4",
			endpoint: "openai-chat",
			params: {
				messages: [{ role: "user", content: "Hello" }],
				apiKey: "sk-789012",
			},
		}

		const key1 = generateVcrKey(descriptor1)
		const key2 = generateVcrKey(descriptor2)

		// Keys should be the same because apiKey is redacted before hashing
		expect(key1).toBe(key2)
	})

	it("should generate file paths with sanitized model IDs", () => {
		const descriptor: VcrRequestDescriptor = {
			providerName: "openrouter",
			model: "anthropic/claude-3-opus",
			endpoint: "openai-chat",
			params: { messages: [] },
		}

		const filePath = getVcrFilePath("/tmp/vcr", "openrouter", "anthropic/claude-3-opus", descriptor)

		// Should replace / with _ in model ID
		expect(filePath).toContain("anthropic_claude-3-opus")
		expect(filePath).toMatch(/\.json$/)
	})
})
