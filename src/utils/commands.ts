import type { CodeActionId, CommandId, TerminalActionId } from "@roo-code/types"

import { COMMAND_PREFIX } from "../constants/ids"

export const getCommand = (id: CommandId) => `${COMMAND_PREFIX}.${id}`

export const getCodeActionCommand = (id: CodeActionId) => `${COMMAND_PREFIX}.${id}`

export const getTerminalCommand = (id: TerminalActionId) => `${COMMAND_PREFIX}.${id}`
