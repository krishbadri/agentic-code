import { ToolArgs } from "./types"

export function getSearchFilesDescription(args: ToolArgs): string {
	return `## search_files
Description: Request to perform a regex search across files in a specified directory, providing context-rich results with surrounding lines.

Parameters:
- path: (required) The path of the directory to search in (relative to the current workspace directory ${args.cwd}). Use "." for workspace root.
- regex: (required) The regular expression pattern to search for. Uses Rust regex syntax.
- file_pattern: (optional) Glob pattern to filter files (e.g., '*.ts' for TypeScript files).

Usage:
<search_files>
<path>directory/to/search</path>
<regex>pattern</regex>
<file_pattern>*.ext</file_pattern>
</search_files>

Examples:

1. Searching for a pattern in a directory:
<search_files>
<path>src</path>
<regex>def test_</regex>
<file_pattern>*.py</file_pattern>
</search_files>

2. Searching the entire workspace:
<search_files>
<path>.</path>
<regex>sqlite</regex>
</search_files>

Search Strategy:
- **ALWAYS provide a <path> parameter** - use "." for workspace root if unsure.
- For vague terms like "all related tests", start with <path>.</path> and use file_pattern to filter.
- Do NOT ask the user for the path - infer a reasonable starting point.`
}
