import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/.cp/**", "**/worktrees/**", "**/dist/**"],
		include: ["src/__tests__/**/*.test.ts", "src/__tests__/**/*.spec.ts"],
		// OCC tests involve git operations which can be slow, especially on Windows
		testTimeout: 30000,
		hookTimeout: 30000,
		// Run tests sequentially to avoid git worktree conflicts
		pool: "forks",
		poolOptions: {
			forks: {
				singleFork: true,
			},
		},
	},
})
