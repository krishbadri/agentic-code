import { describe, it, expect } from "vitest"

/**
 * Helper that applies the grounding-source stripping regexes.
 * In the real Task code, grounding sources arrive as separate "grounding"
 * stream chunks and never enter the assistant message text. These regexes
 * serve as a safety net to clean any source references that might leak
 * into the persisted text.
 */
function stripGroundingSources(text: string): string {
	return text
		.replace(/\[\d+\]\s+[^:\n]+:\s+https?:\/\/[^\s\n]+/g, "") // e.g., "[1] Example Source: https://example.com"
		.replace(/Sources?:\s*[\s\S]*?(?=\n\n|\n$|$)/g, "") // e.g., "Sources: [1](url1), [2](url2)"
		.trim()
}

describe("Task grounding sources handling", () => {
	it("should strip grounding sources from assistant message before persisting to API history", () => {
		// Simulate an assistant message with grounding sources
		const assistantMessageWithSources = `
This is the main response content.

[1] Example Source: https://example.com
[2] Another Source: https://another.com

Sources: [1](https://example.com), [2](https://another.com)
		`.trim()

		// Mock grounding sources
		const mockGroundingSources = [
			{ title: "Example Source", url: "https://example.com" },
			{ title: "Another Source", url: "https://another.com" },
		]

		// Simulate the logic that strips grounding sources
		let cleanAssistantMessage = assistantMessageWithSources
		if (mockGroundingSources.length > 0) {
			cleanAssistantMessage = stripGroundingSources(assistantMessageWithSources)
		}

		// Verify that the cleaned message no longer contains grounding sources
		expect(cleanAssistantMessage).toBe("This is the main response content.")
	})

	it("should not modify assistant message when no grounding sources are present", () => {
		const assistantMessage = "This is a regular response without any sources."
		const mockGroundingSources: any[] = [] // No grounding sources

		// Apply the same logic — stripping only runs when sources are present
		let cleanAssistantMessage = assistantMessage
		if (mockGroundingSources.length > 0) {
			cleanAssistantMessage = stripGroundingSources(assistantMessage)
		}

		// Message should remain unchanged
		expect(cleanAssistantMessage).toBe("This is a regular response without any sources.")
	})

	it("should handle various grounding source formats", () => {
		const testCases = [
			{
				input: "[1] Source Title: https://example.com\n[2] Another: https://test.com\nMain content here",
				expected: "Main content here",
			},
			{
				input: "Content first\n\nSources: [1](https://example.com), [2](https://test.com)",
				expected: "Content first",
			},
			{
				input: "Mixed content\n[1] Inline Source: https://inline.com\nMore content\nSource: [1](https://inline.com)",
				expected: "Mixed content\n\nMore content",
			},
		]

		testCases.forEach(({ input, expected }) => {
			const cleaned = input
				.replace(/\[\d+\]\s+[^:\n]+:\s+https?:\/\/[^\s\n]+/g, "")
				.replace(/Sources?:\s*[\s\S]*?(?=\n\n|\n$|$)/g, "")
				.trim()
			expect(cleaned).toBe(expected)
		})
	})
})
