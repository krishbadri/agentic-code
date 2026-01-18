import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as path from "node:path"
import { Git } from "../git.js"
const pexec = promisify(execFile)

// R31, R32: Tests are "given" - check if a path is a test file
function isTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase()
	if (
		normalized.includes("/test/") ||
		normalized.includes("/tests/") ||
		normalized.includes("/__tests__/") ||
		normalized.startsWith("test/") ||
		normalized.startsWith("tests/") ||
		normalized.startsWith("__tests__/") ||
		normalized.endsWith(".test.ts") ||
		normalized.endsWith(".test.js") ||
		normalized.endsWith(".spec.ts") ||
		normalized.endsWith(".spec.js") ||
		normalized.endsWith(".test.tsx") ||
		normalized.endsWith(".test.jsx") ||
		normalized.endsWith(".spec.tsx") ||
		normalized.endsWith(".spec.jsx")
	) {
		return true
	}
	const basename = normalized.split("/").pop() || ""
	return basename === "test.js" || basename === "test.ts"
}

// Parse git status --porcelain output to extract changed file paths
export function parseGitStatusOutput(output: string): string[] {
	const changedFiles: string[] = []
	const statusLines = output.trim().split("\n").filter(Boolean)
	for (const line of statusLines) {
		// Git status format: XY filename
		// X = index status, Y = working tree status
		// M = modified, A = added, ?? = untracked
		// We want to catch all changes (staged and unstaged)
		// Match: 2 status chars, whitespace, then filename
		const match = line.match(/^.{2}\s+(.+)$/)
		if (match) {
			changedFiles.push(match[1].trim())
		} else {
			// Fallback: if regex doesn't match, try to extract filename after first 2 chars
			// This handles edge cases where format might vary
			const trimmed = line.trim()
			if (trimmed.length > 2) {
				const potentialFile = trimmed.substring(2).trim()
				if (potentialFile) {
					changedFiles.push(potentialFile)
				}
			}
		}
	}
	return changedFiles
}

const HeadersSchema = z.object({
	"x-actor-id": z.string().min(1),
	"x-repo-id": z.string().min(1).optional(),
})

const BodySchema = z.object({
	cmd: z.string(),
	args: z.array(z.string()).default([]),
	cwd_rel: z.string().default(""),
	stdin_base64: z.string().nullable().optional(),
	timeout_ms: z.number().int().default(600000),
	env: z.record(z.string()).default({}),
})

export function registerShellRoutes(app: FastifyInstance) {
	app.post("/shell/exec/:tx_id", async (req, reply) => {
		HeadersSchema.parse(req.headers as any)
		const body = BodySchema.parse((req as any).body || {})
		const whitelist = new Set([
			"node",
			"pnpm",
			"npm",
			"yarn",
			"pytest",
			"go",
			"cargo",
			"make",
			"eslint",
			"prettier",
			"ruff",
			"bash",
			"powershell",
			"pwsh",
			"cmd",
			"cmd.exe",
		])
		if (!whitelist.has(body.cmd)) {
			return reply.code(403).send({ code: "DENIED", message: "Command not allowed" })
		}
		
		// SECURITY: R31/R32 - Pre-execution gate: block commands that reference test files
		const fullCommandString = [body.cmd, ...body.args].join(" ")
		if (isTestFile(fullCommandString)) {
			// Extract test file paths from the command string
			const testFilePaths: string[] = []
			// Match file paths that look like test files (e.g., test/file.test.ts, tests/foo.spec.js)
			const testFilePattern = /(\S*(?:test|tests|__tests__)\/[^\s"']+\.(?:test|spec)\.(?:ts|js|tsx|jsx)|\S+\.(?:test|spec)\.(?:ts|js|tsx|jsx))/gi
			const matches = fullCommandString.match(testFilePattern)
			if (matches) {
				for (const match of matches) {
					// Clean up the match (remove quotes, redirection symbols, etc.)
					const cleaned = match.replace(/^[>"']+|["'<>]+$/g, "").trim()
					if (cleaned && isTestFile(cleaned)) {
						testFilePaths.push(cleaned)
					}
				}
			}
			// If no specific paths found, use the full command string as fallback
			const modifiedTestFiles = testFilePaths.length > 0 ? testFilePaths : [fullCommandString]
			return reply.code(403).send({
				code: "TEST_FILE_PROTECTED",
				message: "R31/R32 violation: Command references test files directly and is blocked before execution.",
				modified_test_files: modifiedTestFiles,
				command: fullCommandString,
			})
		}
		
		const txId = (req.params as any).tx_id
		const git = new Git({ repoRoot: app.repoRoot })
		const worktreePath = git.worktreePath(txId)
		
		const started = Date.now()
		const cwd = path.join(worktreePath, body.cwd_rel || "")
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), body.timeout_ms)
		
		// Helper to check and revert test file modifications
		const checkAndRevertTestFiles = async (): Promise<string[] | null> => {
			try {
				// SECURITY: R31/R32 - Post-exec file-change gate
				// Check for test file modifications using git status (covers all changes: modified, added, untracked)
				const { stdout: statusOutput } = await pexec("git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"], {
					cwd: worktreePath,
					windowsHide: true,
				})
				
				const changedFiles = parseGitStatusOutput(statusOutput)
				
				const modifiedTestFiles: string[] = []
				for (const filePath of changedFiles) {
					if (isTestFile(filePath)) {
						modifiedTestFiles.push(filePath)
					}
				}
				
				// If any test files were modified, revert them
				if (modifiedTestFiles.length > 0) {
					// Revert test files back to HEAD (do NOT stage them)
					for (const testFile of modifiedTestFiles) {
						try {
							// Try restore first (for tracked files)
							await pexec("git", ["restore", "--", testFile], {
								cwd: worktreePath,
								windowsHide: true,
							})
						} catch {
							// If restore fails, file might be new (untracked) - delete it
							try {
								const { unlink } = await import("node:fs/promises")
								await unlink(path.join(worktreePath, testFile))
							} catch {
								// Ignore delete errors (file may not exist)
							}
						}
					}
					return modifiedTestFiles
				}
			} catch {
				// If git commands fail, return null (no test files modified or git error)
			}
			return null
		}
		
		try {
			// Execute the shell command
			const res = await pexec(body.cmd, body.args, {
				cwd,
				env: { ...process.env, ...body.env },
				signal: controller.signal,
				windowsHide: true,
			})
			const duration_ms = Date.now() - started
			clearTimeout(timeout)
			
			// Check for test file modifications after successful execution
			const modifiedTestFiles = await checkAndRevertTestFiles()
			if (modifiedTestFiles) {
				return reply.code(403).send({
					code: "TEST_FILE_PROTECTED",
					message: `R31/R32 violation: Shell command modified test files. Tests are "given" and cannot be modified. Files have been reverted.`,
					modified_test_files: modifiedTestFiles,
					command: [body.cmd, ...body.args].join(" "),
				})
			}
			
			return reply.send({
				exit_code: 0,
				stdout_base64: Buffer.from(res.stdout ?? "").toString("base64"),
				stderr_base64: Buffer.from(res.stderr ?? "").toString("base64"),
				truncated: false,
				duration_ms,
			})
		} catch (err: any) {
			const duration_ms = Date.now() - started
			clearTimeout(timeout)
			
			// Even if command failed, check for test file modifications
			const modifiedTestFiles = await checkAndRevertTestFiles()
			if (modifiedTestFiles) {
				return reply.code(403).send({
					code: "TEST_FILE_PROTECTED",
					message: `R31/R32 violation: Shell command modified test files. Tests are "given" and cannot be modified. Files have been reverted.`,
					modified_test_files: modifiedTestFiles,
					command: [body.cmd, ...body.args].join(" "),
				})
			}
			
			const exit_code = typeof err?.code === "number" ? err.code : 1
			return reply.send({
				exit_code,
				stdout_base64: Buffer.from(err?.stdout ?? "").toString("base64"),
				stderr_base64: Buffer.from(err?.stderr ?? String(err)).toString("base64"),
				truncated: false,
				duration_ms,
			})
		}
	})
}
