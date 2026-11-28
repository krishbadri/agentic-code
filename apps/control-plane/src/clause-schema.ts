/**
 * Strict runtime schema for the R8 Clause language (mirrors packages/types
 * clause.ts). Malformed clauses are rejected with 400 instead of crashing the
 * evaluator (500) or evaluating vacuously (`and: []` used to pass).
 */
import { z } from "zod"
import type { Clause } from "@roo-code/types"

const relPath = z
	.string()
	.min(1)
	.refine((p) => {
		const n = p.replace(/\\/g, "/")
		return !n.startsWith("/") && !/^[A-Za-z]:/.test(n) && !n.split("/").includes("..") && !n.includes("\0")
	}, "path must be relative to the worktree and must not contain '..'")

export const ClauseSchema: z.ZodType<Clause> = z.lazy(() =>
	z.union([
		z.object({ type: z.literal("cmd_exits_0"), cmd: z.string().trim().min(1) }).strict(),
		z.object({ type: z.literal("test_suite"), name: z.string().trim().min(1) }).strict(),
		z.object({ type: z.literal("file_exists"), path: relPath }).strict(),
		z.object({ type: z.literal("not"), clause: ClauseSchema }).strict(),
		z.object({ type: z.literal("and"), clauses: z.array(ClauseSchema).min(1) }).strict(),
		z.object({ type: z.literal("or"), clauses: z.array(ClauseSchema).min(1) }).strict(),
	]),
) as z.ZodType<Clause>
