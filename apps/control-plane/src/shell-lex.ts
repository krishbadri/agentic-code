/**
 * Minimal shell lexer used by the safety checks and the command runner.
 *
 * Goal: understand enough of POSIX sh / bash, PowerShell and cmd.exe to see
 * every *simple command* a script would run (including inside `bash -c "..."`,
 * `$(...)` and backticks) and every output redirection — so safety rules can
 * no longer be bypassed by wrapping a command in another shell.
 *
 * It is deliberately conservative: anything it cannot parse is still returned
 * as tokens, so callers can fail closed.
 */

export interface Redirect {
	op: string
	target: string
}

export interface SimpleCommand {
	argv: string[]
	redirects: Redirect[]
	/** Commands whose stdout feeds this one (`a | b` → b.pipedFrom = [a]) */
	pipedFrom?: SimpleCommand
	/** Nesting depth (0 = top level) */
	depth: number
}

const MAX_DEPTH = 3

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"])
const PWSH = new Set(["pwsh", "powershell", "pwsh.exe", "powershell.exe"])
const CMD = new Set(["cmd", "cmd.exe"])

export function basenameCmd(s: string): string {
	const b = s.replace(/\\/g, "/").split("/").pop() ?? s
	return b.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "")
}

/** Characters that require a real shell to interpret. */
export function needsShell(command: string): boolean {
	let q: string | null = null
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!
		if (q) {
			if (c === q) q = null
			else if (q === '"' && (c === "$" || c === "`")) return true
			continue
		}
		if (c === "'" || c === '"') {
			q = c
			continue
		}
		if ("|&;<>`\n*?~".includes(c)) return true
		if (c === "$") return true
	}
	return false
}

/**
 * Split a command line into argv, honouring quotes. Backslash escapes only
 * shell-special characters, so Windows paths (C:\foo\bar) survive intact.
 */
export function splitArgv(command: string): string[] {
	return tokenize(command)
		.filter((t) => t.kind === "word")
		.map((t) => t.value)
}

type Token = { kind: "word"; value: string; subs: string[] } | { kind: "op"; value: string }

const ESCAPABLE = new Set(['"', "'", "\\", " ", "$", "`", "|", "&", ";", "<", ">", "(", ")", "\n", "\t", "*", "?"])

function tokenize(src: string): Token[] {
	const out: Token[] = []
	let cur = ""
	let has = false
	let subs: string[] = []
	const flush = () => {
		if (has) out.push({ kind: "word", value: cur, subs })
		cur = ""
		has = false
		subs = []
	}
	let i = 0
	while (i < src.length) {
		const c = src[i]!
		// Comments (POSIX): only at word start
		if (c === "#" && !has) {
			while (i < src.length && src[i] !== "\n") i++
			continue
		}
		if (c === "\\") {
			const n = src[i + 1]
			if (n !== undefined && ESCAPABLE.has(n)) {
				cur += n === "\n" ? "" : n
				has = true
				i += 2
				continue
			}
			cur += c
			has = true
			i++
			continue
		}
		if (c === "'") {
			const end = src.indexOf("'", i + 1)
			const stop = end === -1 ? src.length : end
			cur += src.slice(i + 1, stop)
			has = true
			i = stop + 1
			continue
		}
		if (c === '"') {
			i++
			has = true
			while (i < src.length && src[i] !== '"') {
				const d = src[i]!
				if (d === "\\" && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1]!)) {
					cur += src[i + 1]
					i += 2
					continue
				}
				if (d === "$" && src[i + 1] === "(") {
					const [inner, next] = readBalanced(src, i + 2)
					subs.push(inner)
					cur += `$(${inner})`
					i = next
					continue
				}
				if (d === "`") {
					const end = src.indexOf("`", i + 1)
					const stop = end === -1 ? src.length : end
					subs.push(src.slice(i + 1, stop))
					cur += src.slice(i, stop + 1)
					i = stop + 1
					continue
				}
				cur += d
				i++
			}
			i++ // closing quote
			continue
		}
		if (c === "$" && src[i + 1] === "(") {
			const [inner, next] = readBalanced(src, i + 2)
			subs.push(inner)
			cur += `$(${inner})`
			has = true
			i = next
			continue
		}
		if ((c === "<" || c === ">") && src[i + 1] === "(") {
			// process substitution <(cmd) / >(cmd)
			const [inner, next] = readBalanced(src, i + 2)
			subs.push(inner)
			cur += `${c}(${inner})`
			has = true
			i = next
			continue
		}
		if (c === "`") {
			const end = src.indexOf("`", i + 1)
			const stop = end === -1 ? src.length : end
			subs.push(src.slice(i + 1, stop))
			cur += src.slice(i, stop + 1)
			has = true
			i = stop + 1
			continue
		}
		if (c === " " || c === "\t" || c === "\r") {
			flush()
			i++
			continue
		}
		// Operators
		const three = src.slice(i, i + 3)
		const two = src.slice(i, i + 2)
		if (three === "&>>" || three === "2>>") {
			flush()
			out.push({ kind: "op", value: three })
			i += 3
			continue
		}
		if (["&&", "||", ">>", "&>", "2>", ">|", "<<"].includes(two)) {
			// "2>" only counts as an operator at a word boundary
			if (two === "2>" && has) {
				cur += c
				i++
				continue
			}
			flush()
			out.push({ kind: "op", value: two })
			i += 2
			continue
		}
		// Parentheses group commands only at a word boundary; inside a word
		// (e.g. `process.exit(1)`) they are literal characters.
		if ((c === "(" || c === ")") && has) {
			cur += c
			i++
			continue
		}
		if ("|;&\n<>()".includes(c)) {
			flush()
			out.push({ kind: "op", value: c === "\n" ? ";" : c })
			i++
			continue
		}
		cur += c
		has = true
		i++
	}
	flush()
	return out
}

function readBalanced(src: string, start: number): [string, number] {
	let depth = 1
	let i = start
	let q: string | null = null
	while (i < src.length) {
		const c = src[i]!
		if (q) {
			if (c === q) q = null
			else if (c === "\\" && q === '"') i++
		} else if (c === "'" || c === '"') q = c
		else if (c === "(") depth++
		else if (c === ")") {
			depth--
			if (depth === 0) return [src.slice(start, i), i + 1]
		}
		i++
	}
	return [src.slice(start), src.length]
}

const REDIRECT_OPS = new Set([">", ">>", ">|", "&>", "&>>", "2>", "2>>", "<", "<<"])

/**
 * Split a script into the simple commands it would execute, recursing into
 * nested shells and command substitutions.
 */
export function splitCommands(script: string, depth = 0): SimpleCommand[] {
	const tokens = tokenize(script)
	const result: SimpleCommand[] = []
	let argv: string[] = []
	let redirects: Redirect[] = []
	let pendingPipeFrom: SimpleCommand | undefined
	const nested: string[] = []

	const finish = (pipeNext: boolean) => {
		let cmd: SimpleCommand | undefined
		if (argv.length > 0 || redirects.length > 0) {
			cmd = { argv, redirects, depth, ...(pendingPipeFrom ? { pipedFrom: pendingPipeFrom } : {}) }
			result.push(cmd)
			if (depth < MAX_DEPTH) result.push(...expandNestedShell(argv, depth))
		}
		pendingPipeFrom = pipeNext ? cmd : undefined
		argv = []
		redirects = []
	}

	for (let t = 0; t < tokens.length; t++) {
		const tok = tokens[t]!
		if (tok.kind === "word") {
			argv.push(tok.value)
			nested.push(...tok.subs)
			continue
		}
		if (REDIRECT_OPS.has(tok.value)) {
			const next = tokens[t + 1]
			if (next && next.kind === "word") {
				redirects.push({ op: tok.value, target: next.value })
				nested.push(...next.subs)
				t++
			}
			continue
		}
		if (tok.value === "|") {
			finish(true)
			continue
		}
		// ; && || & ( ) all terminate a simple command
		finish(false)
	}
	finish(false)

	if (depth < MAX_DEPTH) {
		for (const sub of nested) result.push(...splitCommands(sub, depth + 1))
	}
	return result
}

/** If argv runs another shell with an inline script, parse that script too. */
function expandNestedShell(argv: string[], depth: number): SimpleCommand[] {
	if (argv.length === 0) return []
	let i = 0
	// Skip wrappers: sudo, env VAR=1, nohup, time, exec, command, xargs
	while (i < argv.length) {
		const b = basenameCmd(argv[i]!)
		if (["sudo", "nohup", "time", "exec", "command", "nice", "doas"].includes(b)) {
			i++
			while (i < argv.length && argv[i]!.startsWith("-")) i++
			continue
		}
		if (b === "env") {
			i++
			while (i < argv.length && (argv[i]!.includes("=") || argv[i]!.startsWith("-"))) i++
			continue
		}
		break
	}
	const prog = argv[i]
	if (!prog) return []
	const b = basenameCmd(prog)
	const rest = argv.slice(i + 1)
	if (SHELLS.has(b)) {
		const idx = rest.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))
		if (idx >= 0 && rest[idx + 1] !== undefined) return splitCommands(rest[idx + 1]!, depth + 1)
		return []
	}
	if (PWSH.has(b)) {
		const idx = rest.findIndex((a) => /^-(c|command)$/i.test(a))
		if (idx >= 0) return splitCommands(rest.slice(idx + 1).join(" "), depth + 1)
		return []
	}
	if (CMD.has(b)) {
		const idx = rest.findIndex((a) => /^\/[ck]$/i.test(a))
		if (idx >= 0) return splitCommands(rest.slice(idx + 1).join(" "), depth + 1)
		return []
	}
	return []
}

/**
 * Strip wrapper prefixes (sudo, env X=1, nohup, ...) and return the effective
 * program + args of a simple command.
 */
export function effectiveArgv(argv: string[]): { prog: string; args: string[]; elevated: boolean } {
	let i = 0
	let elevated = false
	while (i < argv.length) {
		const raw = argv[i]!
		const b = basenameCmd(raw)
		if (b === "sudo" || b === "doas") {
			elevated = true
			i++
			while (i < argv.length && argv[i]!.startsWith("-")) i++
			continue
		}
		if (["nohup", "time", "exec", "command", "nice"].includes(b)) {
			i++
			continue
		}
		if (b === "env") {
			i++
			while (i < argv.length && (argv[i]!.includes("=") || argv[i]!.startsWith("-"))) i++
			continue
		}
		// VAR=value prefix
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
			i++
			continue
		}
		break
	}
	return { prog: argv[i] ? basenameCmd(argv[i]!) : "", args: argv.slice(i + 1), elevated }
}
