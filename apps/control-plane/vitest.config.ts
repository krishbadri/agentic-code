import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/.cp/**", "**/worktrees/**", "**/dist/**"],
		include: ["src/__tests__/**/*.test.ts", "src/__tests__/**/*.spec.ts"],
		testTimeout: 15000,
		hookTimeout: 15000,
	},
})
