import { DiffStrategy } from "../../../shared/tools"
import { McpHub } from "../../../services/mcp/McpHub"
import { CodeIndexManager } from "../../../services/code-index/manager"

export function getCapabilitiesSection(
	cwd: string,
	supportsComputerUse: boolean,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	codeIndexManager?: CodeIndexManager,
): string {
	return `====

CAPABILITIES

- You have access to tools for CLI commands, file listing, source code definitions, regex search${
		supportsComputerUse ? ", browser interaction" : ""
	}, reading/writing files, and follow-up questions.
- A recursive file listing of '${cwd}' is included in environment_details. Use list_files to explore directories outside the workspace (pass 'true' for recursive listing).${
		codeIndexManager &&
		codeIndexManager.isFeatureEnabled &&
		codeIndexManager.isFeatureConfigured &&
		codeIndexManager.isInitialized
			? `
- Use \`codebase_search\` for semantic search across the codebase—effective for finding relevant code even without exact keywords.`
			: ""
	}
- Use search_files for regex searches across directories with context-rich results.
- Use list_code_definition_names to get source code definitions at a directory's top level for understanding code structure and relationships.
- Use execute_command to run CLI commands. Provide clear explanations. Prefer complex CLI commands over scripts. Interactive and long-running commands are allowed in the user's VSCode terminal; each runs in a new terminal instance.${
		supportsComputerUse
			? "\n- Use browser_action for Puppeteer-controlled browser interaction—useful for web development to launch, navigate, click, type, and capture screenshots/console logs."
			: ""
	}${
		mcpHub
			? `
- You have access to MCP servers that may provide additional tools and resources.`
			: ""
	}`
}
