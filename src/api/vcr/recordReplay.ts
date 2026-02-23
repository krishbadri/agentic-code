import * as fs from "fs/promises"
import * as path from "path"
import { getVcrConfig, type VcrConfig } from "./vcrConfig"
import { redactSensitiveFields } from "./redaction"
import { getVcrFilePath } from "./key"

/**
 * Request descriptor for stable key generation
 */
export interface VcrRequestDescriptor {
	providerName: string
	model: string
	endpoint: "openai-chat" | "openai-responses" | "anthropic-messages"
	// Request parameters that affect output
	params: {
		messages?: unknown[]
		system?: string | unknown[]
		temperature?: number
		max_tokens?: number
		maxTokens?: number
		stream?: boolean
		stream_options?: unknown
		[key: string]: unknown
	}
}

/**
 * VCR recording format
 */
export interface VcrRecording {
	meta: {
		provider: string
		model: string
		protocol: "openai" | "anthropic"
		createdAt: string
		version: string
	}
	request: VcrRequestDescriptor
	stream: unknown[]
}

const VCR_VERSION = "1.0.0"

/**
 * Record a stream to a VCR file
 */
async function recordStream(
	descriptor: VcrRequestDescriptor,
	stream: AsyncIterable<unknown>,
	config: VcrConfig,
): Promise<AsyncIterable<unknown>> {
	const chunks: unknown[] = []
	const filePath = getVcrFilePath(config.dir, descriptor.providerName, descriptor.model, descriptor)

	// Ensure directory exists
	await fs.mkdir(path.dirname(filePath), { recursive: true })

	// Create async generator that records and yields
	async function* recordAndYield() {
		for await (const chunk of stream) {
			chunks.push(chunk)
			yield chunk
		}

		// After stream completes, write recording
		const protocol = descriptor.endpoint === "anthropic-messages" ? "anthropic" : "openai"
		const recording: VcrRecording = {
			meta: {
				provider: descriptor.providerName,
				model: descriptor.model,
				protocol,
				createdAt: new Date().toISOString(),
				version: VCR_VERSION,
			},
			request: redactSensitiveFields(descriptor),
			stream: chunks,
		}

		// Atomic write: write to temp file then rename
		const tempPath = `${filePath}.tmp`
		await fs.writeFile(tempPath, JSON.stringify(recording, null, 2), "utf-8")
		await fs.rename(tempPath, filePath)
	}

	return recordAndYield()
}

/**
 * Replay a stream from a VCR file
 */
async function replayStream(descriptor: VcrRequestDescriptor, config: VcrConfig): Promise<AsyncIterable<unknown>> {
	const filePath = getVcrFilePath(config.dir, descriptor.providerName, descriptor.model, descriptor)

	try {
		const content = await fs.readFile(filePath, "utf-8")
		const recording: VcrRecording = JSON.parse(content)

		// Create async generator that yields recorded chunks
		async function* replay() {
			for (const chunk of recording.stream) {
				yield chunk
			}
		}

		return replay()
	} catch (error: any) {
		if (error.code === "ENOENT") {
			throw new Error(
				`VCR replay failed: Recording not found at ${filePath}. ` +
					`Run with ROO_VCR_MODE=record to create the recording first.`,
			)
		}
		throw error
	}
}

/**
 * Wrap a stream with VCR record/replay logic
 *
 * @param descriptor Request descriptor for key generation
 * @param stream Original stream (only used in record mode)
 * @returns Wrapped stream that records or replays based on VCR_MODE
 */
export async function maybeVcrWrapStream<T>(
	descriptor: VcrRequestDescriptor,
	stream: AsyncIterable<T>,
): Promise<AsyncIterable<T>> {
	const config = getVcrConfig()

	if (config.mode === "off") {
		return stream
	}

	if (config.mode === "replay") {
		return (await replayStream(descriptor, config)) as AsyncIterable<T>
	}

	if (config.mode === "record") {
		return (await recordStream(descriptor, stream, config)) as AsyncIterable<T>
	}

	return stream
}

/**
 * VCR wrapper that avoids creating the real stream in replay mode.
 *
 * This is critical for CI determinism: in replay mode we must not make any live network call.
 */
export async function maybeVcrWrapStreamLazy<T>(
	descriptor: VcrRequestDescriptor,
	createStream: () => Promise<AsyncIterable<T>>,
): Promise<AsyncIterable<T>> {
	const config = getVcrConfig()

	if (config.mode === "off") {
		return await createStream()
	}

	if (config.mode === "replay") {
		return (await replayStream(descriptor, config)) as AsyncIterable<T>
	}

	if (config.mode === "record") {
		const stream = await createStream()
		return (await recordStream(descriptor, stream as AsyncIterable<unknown>, config)) as AsyncIterable<T>
	}

	return await createStream()
}
