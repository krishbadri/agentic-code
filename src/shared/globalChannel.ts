// Provides a single OutputChannel instance accessible anywhere after activate()
import * as vscode from "vscode"

let chan: vscode.OutputChannel | undefined

export function setGlobalChannel(c: vscode.OutputChannel) {
	chan = c
}

export function getGlobalChannel(): vscode.OutputChannel {
	if (!chan) {
		throw new Error("global outputChannel not initialised yet")
	}
	return chan
}
