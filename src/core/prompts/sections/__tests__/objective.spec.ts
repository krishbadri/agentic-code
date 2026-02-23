import { getObjectiveSection } from "../objective"
import type { CodeIndexManager } from "../../../../services/code-index/manager"

describe("getObjectiveSection", () => {
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
		it("should include codebase_search first enforcement in thinking process", () => {
			const objective = getObjectiveSection(mockCodeIndexManagerEnabled)

			// Check that the objective includes the codebase_search enforcement
			expect(objective).toContain("use `codebase_search` for any new code area exploration")
		})
	})

	describe("when codebase_search is not available", () => {
		it("should not include codebase_search enforcement", () => {
			const objective = getObjectiveSection(mockCodeIndexManagerDisabled)

			// Check that the objective does not include the codebase_search enforcement
			expect(objective).not.toContain("codebase_search")
		})
	})

	it("should maintain proper structure regardless of codebase_search availability", () => {
		const objectiveEnabled = getObjectiveSection(mockCodeIndexManagerEnabled)
		const objectiveDisabled = getObjectiveSection(mockCodeIndexManagerDisabled)

		// Check that all numbered items are present in both cases
		for (const objective of [objectiveEnabled, objectiveDisabled]) {
			expect(objective).toContain("1. Analyze the user's task")
			expect(objective).toContain("2. Work through these goals sequentially")
			expect(objective).toContain("3. Before calling a tool")
			expect(objective).toContain("4. Once you've completed the user's task")
			expect(objective).toContain("5. The user may provide feedback")
		}
	})

	it("should include analysis guidance regardless of codebase_search availability", () => {
		const objectiveEnabled = getObjectiveSection(mockCodeIndexManagerEnabled)
		const objectiveDisabled = getObjectiveSection(mockCodeIndexManagerDisabled)

		// Check that analysis guidance is included in both cases
		for (const objective of [objectiveEnabled, objectiveDisabled]) {
			expect(objective).toContain("Before calling a tool, do some analysis")
			expect(objective).toContain("analyze the file structure in environment_details")
			expect(objective).toContain("Choose the most relevant tool")
		}
	})

	it("should include parameter inference guidance regardless of codebase_search availability", () => {
		const objectiveEnabled = getObjectiveSection(mockCodeIndexManagerEnabled)
		const objectiveDisabled = getObjectiveSection(mockCodeIndexManagerDisabled)

		// Check parameter inference guidance in both cases
		for (const objective of [objectiveEnabled, objectiveDisabled]) {
			expect(objective).toContain("required parameters are present or inferable")
			expect(objective).toContain("ask_followup_question")
		}
	})
})
