import * as path from "path"

/**
 * VCR (Video Cassette Recorder) Configuration
 * 
 * Environment variables:
 * - ROO_VCR_MODE: "off" | "record" | "replay" (default: "off")
 * - ROO_VCR_DIR: Directory for VCR fixtures (default: "src/__tests__/__fixtures__/vcr/")
 * 
 * Usage:
 * - ROO_VCR_MODE=record: Execute real API calls and save responses to fixtures
 * - ROO_VCR_MODE=replay: Load fixtures and replay responses (no network calls)
 * - ROO_VCR_MODE=off: Normal operation (no recording/replaying)
 */
export type VcrMode = "off" | "record" | "replay"

export interface VcrConfig {
	mode: VcrMode
	dir: string
}

/**
 * Get VCR configuration from environment variables
 */
export function getVcrConfig(): VcrConfig {
	const mode = (process.env.ROO_VCR_MODE || "off").toLowerCase() as VcrMode
	if (mode !== "off" && mode !== "record" && mode !== "replay") {
		throw new Error(`Invalid ROO_VCR_MODE: ${mode}. Must be "off", "record", or "replay"`)
	}

	const defaultDir = path.resolve(process.cwd(), "src/__tests__/__fixtures__/vcr/")
	const dir = process.env.ROO_VCR_DIR ? path.resolve(process.env.ROO_VCR_DIR) : defaultDir

	return { mode, dir }
}

/**
 * Check if VCR is enabled (record or replay mode)
 */
export function isVcrEnabled(): boolean {
	const config = getVcrConfig()
	return config.mode !== "off"
}
