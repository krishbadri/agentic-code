import os from "os"
import osName from "os-name"

import { getShell } from "../../../utils/shell"

export function getSystemInfoSection(cwd: string): string {
	let details = `====

SYSTEM INFORMATION

Operating System: ${osName()}
Default Shell: ${getShell()}
Home Directory: ${os.homedir().toPosix()}
Current Workspace Directory: ${cwd.toPosix()}

The Current Workspace Directory is the default for all tool operations and new terminals. Changing directories in a terminal does not change the workspace directory.`

	return details
}
