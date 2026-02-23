import { getToolUseGuidelinesSection } from "../tool-use-guidelines"
import type { CodeIndexManager } from "../../../../services/code-index/manager"

describe("getToolUseGuidelinesSection", () => {
	// Mock CodeIndexManager with codebase search available
	const mockCodeIndexManagerEnabled = {
		isFeatureEnabled: true,
		isFeatureConfigured: true,
		isInitialized: true,
	} as CodeIndexManager

	// Mock CodeIndexManager with codebase search unavailable
	const mockCodeIndexManagerDisabled = {
		isFeatureEnabled: false,
		isFeatureConfigured: false,
		isInitialized: false,
	} as CodeIndexManager

	describe("when codebase_search is available", () => {
		it("should include codebase_search first enforcement", () => {
			const guidelines = getToolUseGuidelinesSection(mockCodeIndexManagerEnabled)

			// Check that the guidelines include the codebase_search enforcement
			expect(guidelines).toContain(
				"CRITICAL: Always use `codebase_search` FIRST before other search/exploration tools",
			)
			expect(guidelines).toContain("semantic search based on meaning")
		})

		it("should maintain proper numbering with codebase_search", () => {
			const guidelines = getToolUseGuidelinesSection(mockCodeIndexManagerEnabled)

			// Check that all numbered items are present
			expect(guidelines).toContain("1. Assess what information")
			expect(guidelines).toContain("2. **CRITICAL:")
			expect(guidelines).toContain("3. Choose the most appropriate tool")
			expect(guidelines).toContain("4. If multiple actions are needed")
			expect(guidelines).toContain("5. Formulate your tool use")
			expect(guidelines).toContain("6. After each tool use")
			expect(guidelines).toContain("7. ALWAYS wait for user confirmation")
		})
	})

	describe("when codebase_search is not available", () => {
		it("should not include codebase_search enforcement", () => {
			const guidelines = getToolUseGuidelinesSection(mockCodeIndexManagerDisabled)

			// Check that the guidelines do not include the codebase_search enforcement
			expect(guidelines).not.toContain("codebase_search")
		})

		it("should maintain proper numbering without codebase_search", () => {
			const guidelines = getToolUseGuidelinesSection(mockCodeIndexManagerDisabled)

			// Check that all numbered items are present with correct numbering
			expect(guidelines).toContain("1. Assess what information")
			expect(guidelines).toContain("2. Choose the most appropriate tool")
			expect(guidelines).toContain("3. If multiple actions are needed")
			expect(guidelines).toContain("4. Formulate your tool use")
			expect(guidelines).toContain("5. After each tool use")
			expect(guidelines).toContain("6. ALWAYS wait for user confirmation")
		})
	})

	it("should include wait-for-confirmation guideline regardless of codebase_search availability", () => {
		const guidelinesEnabled = getToolUseGuidelinesSection(mockCodeIndexManagerEnabled)
		const guidelinesDisabled = getToolUseGuidelinesSection(mockCodeIndexManagerDisabled)

		// Check that the wait-for-confirmation guideline is included in both cases
		for (const guidelines of [guidelinesEnabled, guidelinesDisabled]) {
			expect(guidelines).toContain("ALWAYS wait for user confirmation")
		}
	})
})
