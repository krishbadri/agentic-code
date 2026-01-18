/**
 * Action-Safety (R6, Slides 39/64)
 *
 * Deterministic checks BEFORE executing tool calls (bash/file ops).
 * Blocks unsafe actions before they run.
 *
 * Categories:
 * - File operations: block writes to protected paths
 * - Bash commands: block dangerous commands (rm -rf /, sudo, etc.)
 * - Network: block outbound requests to untrusted hosts
 */

export interface ActionSafetyCheck {
	action: string
	actionType: "file_write" | "file_delete" | "bash" | "network" | "unknown"
	args: Record<string, unknown>
	allowed: boolean
	reason?: string
	rule?: string
}

export interface ActionSafetyConfig {
	// Paths that are protected from modification
	protectedPaths: string[]
	// Dangerous bash patterns to block
	dangerousBashPatterns: RegExp[]
	// Allowed bash command prefixes
	allowedBashPrefixes: string[]
	// Blocked network hosts
	blockedHosts: string[]
}

const DEFAULT_CONFIG: ActionSafetyConfig = {
	protectedPaths: [
		// System paths
		"/etc",
		"/usr",
		"/bin",
		"/sbin",
		"/var",
		"/root",
		"C:\\Windows",
		"C:\\Program Files",
		// Git internals
		".git",
		// Package manager internals
		"node_modules",
		// Test files (R31, R32 - tests are given)
		"**/__tests__/**",
		"**/test/**",
		"**/tests/**",
		"**/*.test.ts",
		"**/*.test.js",
		"**/*.spec.ts",
		"**/*.spec.js",
	],
	dangerousBashPatterns: [
		// Destructive commands
		/\brm\s+(-rf?|--recursive)\s+[\/\\]/i, // rm -rf /
		/\brm\s+(-rf?|--recursive)\s+\.\./i, // rm -rf ..
		/\bsudo\s+rm/i, // sudo rm
		/\bdd\s+.*of=\/dev\//i, // dd to device
		/\bmkfs\b/i, // format filesystem
		/\bformat\s+[a-z]:/i, // Windows format
		// Privilege escalation
		/\bsudo\s+su\b/i,
		/\bsudo\s+-i\b/i,
		/\bchmod\s+777\s+\//i,
		// Network exfiltration
		/\bcurl\s+.*\|\s*bash/i, // curl | bash
		/\bwget\s+.*\|\s*sh/i, // wget | sh
		// Crypto mining / malware patterns
		/\bxmrig\b/i,
		/\bcryptominer\b/i,
		// Fork bombs
		/:\(\)\s*{\s*:\|:\s*&\s*}\s*;/,
	],
	allowedBashPrefixes: [
		"npm",
		"pnpm",
		"yarn",
		"node",
		"npx",
		"git",
		"tsc",
		"eslint",
		"prettier",
		"vitest",
		"jest",
		"cat",
		"ls",
		"pwd",
		"echo",
		"mkdir",
		"cp",
		"mv",
		"touch",
		"head",
		"tail",
		"grep",
		"find",
		"wc",
	],
	blockedHosts: ["localhost:22", "0.0.0.0", "169.254.169.254"], // AWS metadata, SSH
}

/**
 * Check if a file path is protected.
 */
function isPathProtected(filePath: string, protectedPaths: string[]): { protected: boolean; rule?: string } {
	const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase()

	for (const pattern of protectedPaths) {
		const normalizedPattern = pattern.replace(/\\/g, "/").toLowerCase()

		// Glob pattern matching
		if (normalizedPattern.includes("*")) {
			const regex = new RegExp(
				"^" + normalizedPattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$",
				"i",
			)
			if (regex.test(normalizedPath)) {
				return { protected: true, rule: `matches pattern: ${pattern}` }
			}
		} else {
			// Prefix matching
			if (normalizedPath.startsWith(normalizedPattern) || normalizedPath.includes("/" + normalizedPattern)) {
				return { protected: true, rule: `protected path: ${pattern}` }
			}
		}
	}

	return { protected: false }
}

/**
 * Check if a bash command is dangerous.
 */
function isBashDangerous(
	command: string,
	config: ActionSafetyConfig,
): { dangerous: boolean; rule?: string } {
	// Check against dangerous patterns
	for (const pattern of config.dangerousBashPatterns) {
		if (pattern.test(command)) {
			return { dangerous: true, rule: `matches dangerous pattern: ${pattern.source}` }
		}
	}

	// Check if command starts with allowed prefix
	const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase()
	if (firstWord && !config.allowedBashPrefixes.some((p) => firstWord === p.toLowerCase())) {
		// Unknown command - check if it looks suspicious
		if (command.includes("sudo") || command.includes("su ")) {
			return { dangerous: true, rule: "privilege escalation attempt" }
		}
	}

	return { dangerous: false }
}

/**
 * Perform action-safety check before tool execution.
 *
 * Returns structured result with allow/block decision and reason.
 */
export function checkActionSafety(
	action: string,
	args: Record<string, unknown>,
	config: ActionSafetyConfig = DEFAULT_CONFIG,
): ActionSafetyCheck {
	const result: ActionSafetyCheck = {
		action,
		actionType: "unknown",
		args,
		allowed: true,
	}

	// Determine action type and check
	switch (action.toLowerCase()) {
		case "write_file":
		case "file_write":
		case "write": {
			result.actionType = "file_write"
			const filePath = String(args.file_path || args.path || "")
			const pathCheck = isPathProtected(filePath, config.protectedPaths)
			if (pathCheck.protected) {
				result.allowed = false
				result.reason = `File write blocked: ${pathCheck.rule}`
				result.rule = pathCheck.rule
			}
			break
		}

		case "delete_file":
		case "file_delete":
		case "delete": {
			result.actionType = "file_delete"
			const filePath = String(args.file_path || args.path || "")
			const pathCheck = isPathProtected(filePath, config.protectedPaths)
			if (pathCheck.protected) {
				result.allowed = false
				result.reason = `File delete blocked: ${pathCheck.rule}`
				result.rule = pathCheck.rule
			}
			break
		}

		case "bash":
		case "shell":
		case "execute":
		case "run_command": {
			result.actionType = "bash"
			const command = String(args.command || args.cmd || "")
			const bashCheck = isBashDangerous(command, config)
			if (bashCheck.dangerous) {
				result.allowed = false
				result.reason = `Bash command blocked: ${bashCheck.rule}`
				result.rule = bashCheck.rule
			}
			break
		}

		case "fetch":
		case "http":
		case "request": {
			result.actionType = "network"
			const url = String(args.url || args.host || "")
			for (const blocked of config.blockedHosts) {
				if (url.includes(blocked)) {
					result.allowed = false
					result.reason = `Network request blocked: host ${blocked} is blocked`
					result.rule = `blocked host: ${blocked}`
				}
			}
			break
		}

		default:
			result.actionType = "unknown"
			// Unknown actions are allowed by default (fail-open for flexibility)
			break
	}

	return result
}

/**
 * Structured log event for action-safety decisions.
 */
export interface ActionSafetyEvent {
	type: "action_safety"
	timestamp: number
	txId?: string
	subTxId?: string
	action: string
	actionType: string
	allowed: boolean
	reason?: string
	rule?: string
}

/**
 * Create a structured log event for an action-safety check.
 */
export function createActionSafetyEvent(
	check: ActionSafetyCheck,
	txId?: string,
	subTxId?: string,
): ActionSafetyEvent {
	return {
		type: "action_safety",
		timestamp: Date.now(),
		txId,
		subTxId,
		action: check.action,
		actionType: check.actionType,
		allowed: check.allowed,
		reason: check.reason,
		rule: check.rule,
	}
}
