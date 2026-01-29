import { RooCodeEventName, type RooCodeAPI } from "@roo-code/types"
import * as child_process from "child_process"

type WaitForOptions = {
	timeout?: number
	interval?: number
}

// Deferred promise utility for fast-fail mechanism
export function createDeferred<T>(): {
	promise: Promise<T>
	resolve: (value: T) => void
	reject: (error: Error) => void
} {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

export const waitFor = (
	condition: (() => Promise<boolean>) | (() => boolean),
	{ timeout = 30_000, interval = 250 }: WaitForOptions = {},
) => {
	let timeoutId: NodeJS.Timeout | undefined = undefined

	return Promise.race([
		new Promise<void>((resolve, reject) => {
			const check = async () => {
				try {
					const result = condition()
					const isSatisfied = result instanceof Promise ? await result : result

					if (isSatisfied) {
						if (timeoutId) {
							clearTimeout(timeoutId)
							timeoutId = undefined
						}

						resolve()
					} else {
						setTimeout(check, interval)
					}
				} catch (error) {
					// If condition throws, reject immediately
					if (timeoutId) {
						clearTimeout(timeoutId)
						timeoutId = undefined
					}
					reject(error)
				}
			}

			check()
		}),
		new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(new Error(`Timeout after ${Math.floor(timeout / 1000)}s`))
			}, timeout)
		}),
	])
}

type WaitUntilAbortedOptions = WaitForOptions & {
	api: RooCodeAPI
	taskId: string
}

export const waitUntilAborted = async ({ api, taskId, ...options }: WaitUntilAbortedOptions) => {
	const set = new Set<string>()
	api.on(RooCodeEventName.TaskAborted, (taskId) => set.add(taskId))
	await waitFor(() => set.has(taskId), options)
}

type WaitUntilCompletedOptions = WaitForOptions & {
	api: RooCodeAPI
	taskId: string
}

export const waitUntilCompleted = async ({ api, taskId, ...options }: WaitUntilCompletedOptions) => {
	const completedSet = new Set<string>()
	const abortedSet = new Set<string>()
	
	// Set up listeners
	const onCompleted = (id: string) => completedSet.add(id)
	const onAborted = (id: string) => abortedSet.add(id)
	
	api.on(RooCodeEventName.TaskCompleted, onCompleted)
	api.on(RooCodeEventName.TaskAborted, onAborted)
	
	try {
		// Check immediately before starting polling (in case event already fired)
		if (abortedSet.has(taskId)) {
			throw new Error(`Task ${taskId} was aborted`)
		}
		if (completedSet.has(taskId)) {
			return
		}
		
		// Use shorter interval for faster detection (50ms instead of default 250ms)
		// Check both completed and aborted states - abort takes precedence
		await waitFor(() => {
			if (abortedSet.has(taskId)) {
				throw new Error(`Task ${taskId} was aborted`)
			}
			return completedSet.has(taskId)
		}, { ...options, interval: 50 })
	} finally {
		// Clean up listeners immediately to prevent further processing
		api.off(RooCodeEventName.TaskCompleted, onCompleted)
		api.off(RooCodeEventName.TaskAborted, onAborted)
	}
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
