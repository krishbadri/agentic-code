/**
 * R31/R32: "tests are given". Single source of truth for what counts as a test
 * file (previously three diverging copies in tx.ts, shell.ts, action-safety.ts).
 */

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "__mocks__"])
const JS_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)"

const TEST_FILE_PATTERNS: RegExp[] = [
	// JS / TS family: foo.test.ts, foo.spec.jsx, ...
	new RegExp(`\\.(?:test|spec)\\.${JS_EXT}$`, "i"),
	// Python
	/(?:^|\/)test_[^/]*\.py$/i,
	/_test\.py$/i,
	/(?:^|\/)conftest\.py$/i,
	// Go
	/_test\.go$/i,
	// Ruby
	/_spec\.rb$/i,
	/_test\.rb$/i,
	// Java / Kotlin
	/Tests?\.(?:java|kt)$/,
	// .NET
	/Tests?\.cs$/,
	// Rust integration tests live under tests/ (covered by TEST_DIRS)
	// Bare test entry points
	new RegExp(`(?:^|/)test\\.${JS_EXT}$`, "i"),
]

/** Normalise to forward slashes, strip leading "./" and a leading "a/" / "b/" diff prefix is NOT stripped. */
export function normalizeRelPath(p: string): string {
	let n = p.replace(/\\/g, "/").trim()
	while (n.startsWith("./")) n = n.slice(2)
	return n
}

export function isTestFile(filePath: string): boolean {
	const n = normalizeRelPath(filePath)
	if (!n) return false
	const segments = n.split("/").filter(Boolean)
	// Any directory segment (not the file name itself) that is a test dir
	for (let i = 0; i < segments.length - 1; i++) {
		if (TEST_DIRS.has(segments[i]!.toLowerCase())) return true
	}
	return TEST_FILE_PATTERNS.some((re) => re.test(n))
}

/**
 * Check if test file modification is allowed via SERVER-SIDE allowlist.
 * An empty allowlist means no test modifications are allowed.
 */
export function isTestModifyAllowed(filePath: string, allowlist: string[]): boolean {
	if (!allowlist || allowlist.length === 0) return false
	const normalized = normalizeRelPath(filePath).toLowerCase()
	for (const pattern of allowlist) {
		const p = normalizeRelPath(pattern).toLowerCase()
		if (normalized === p) return true
		if (p.includes("*")) {
			const re = new RegExp(
				"^" +
					p
						.replace(/[.+^${}()|[\]]/g, "\\$&")
						.replace(/\*\*/g, "\0")
						.replace(/\*/g, "[^/]*")
						.replace(/\0/g, ".*") +
					"$",
				"i",
			)
			if (re.test(normalized)) return true
		}
		if (p.endsWith("/") && normalized.startsWith(p)) return true
	}
	return false
}
