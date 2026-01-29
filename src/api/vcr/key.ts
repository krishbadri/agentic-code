import { createHash } from "crypto"
import type { VcrRequestDescriptor } from "./recordReplay"
import { redactSensitiveFields } from "./redaction"

/**
 * Generate a stable hash key from a request descriptor
 * 
 * The key is deterministic: same normalized request => same hash
 * Sensitive fields are redacted before hashing.
 */
/**
 * Recursively sort object keys for deterministic JSON stringification
 */
function sortKeysRecursively(obj: unknown): unknown {
	if (obj === null || obj === undefined || typeof obj !== "object") {
		return obj
	}

	if (Array.isArray(obj)) {
		return obj.map(sortKeysRecursively)
	}

	const sorted: Record<string, unknown> = {}
	const keys = Object.keys(obj).sort()
	for (const key of keys) {
		sorted[key] = sortKeysRecursively((obj as Record<string, unknown>)[key])
	}
	return sorted
}

export function generateVcrKey(descriptor: VcrRequestDescriptor): string {
	// Deep clone and redact sensitive fields
	const normalized = redactSensitiveFields(descriptor)

	// Sort keys recursively for deterministic ordering
	const sorted = sortKeysRecursively(normalized)

	// Create a stable string representation
	const normalizedStr = JSON.stringify(sorted)

	// Hash using SHA256
	const hash = createHash("sha256").update(normalizedStr).digest("hex")

	// Return first 16 chars (sufficient for uniqueness, shorter paths)
	return hash.substring(0, 16)
}

/**
 * Generate file path for a VCR recording
 */
export function getVcrFilePath(
	vcrDir: string,
	providerName: string,
	modelId: string,
	descriptor: VcrRequestDescriptor,
): string {
	const key = generateVcrKey(descriptor)
	// Sanitize modelId for filesystem (replace / with _)
	const safeModelId = modelId.replace(/\//g, "_")
	return `${vcrDir}/${providerName}/${safeModelId}/${key}.json`
}
