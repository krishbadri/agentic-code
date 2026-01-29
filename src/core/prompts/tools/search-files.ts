import { ToolArgs } from "./types"

export function getSearchFilesDescription(args: ToolArgs): string {
	return `## search_files
Description: Request to perform a regex search across files in a specified directory, providing context-rich results. This tool searches for patterns or specific content across multiple files, displaying each match with encapsulating context.

Parameters:
- path: (required) The path of the directory to search in (relative to the current workspace directory ${args.cwd}). This directory will be recursively searched. Use "." to search the entire workspace root.
- regex: (required) The regular expression pattern to search for. Uses Rust regex syntax.
- file_pattern: (optional) Glob pattern to filter files (e.g., '*.ts' for TypeScript files). If not provided, it will search all files (*).

⚠️ CRITICAL: You MUST use XML format. Function-call syntax like search_files([...]) will NOT work.

Usage (XML format ONLY):
<search_files>
<path>directory/to/search</path>
<regex>pattern</regex>
<file_pattern>*.ext</file_pattern>
</search_files>

❌ DO NOT use: search_files({ path: "src", regex: "test" }) or search_files("src", "test")

Examples:

1. Searching for all test files in the workspace:
<search_files>
<path>.</path>
<regex>.*</regex>
<file_pattern>*test*.py</file_pattern>
</search_files>

2. Searching for a specific pattern in a directory:
<search_files>
<path>src</path>
<regex>def test_</regex>
<file_pattern>*.py</file_pattern>
</search_files>

3. Searching the entire workspace for any file containing "sqlite":
<search_files>
<path>.</path>
<regex>sqlite</regex>
</search_files>

4. Finding all Python files in tests directory:
<search_files>
<path>tests</path>
<regex>.*</regex>
<file_pattern>*.py</file_pattern>
</search_files>

IMPORTANT: You MUST use this Robust Search Strategy:
- **ALWAYS provide a <path> parameter** - it is REQUIRED. If you don't know the exact directory:
  - Use "." to search the entire workspace root
  - Use "tests" or "src" for common directories
  - Use the directory mentioned in the task description
- **If the task says "all related tests" or similar vague terms:**
  - Start with <path>.</path> to search the entire workspace
  - Use <file_pattern>*test*.py</file_pattern> or similar to filter for test files
  - Then narrow down based on results
- **DO NOT ask the user for the path** - always infer a reasonable starting point (usually "." for workspace root)
- **If unsure, use "." (workspace root)** - it's better to search broadly than to omit the path parameter`
}
