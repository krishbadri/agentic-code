# Dependencies / vendor

node_modules/
.pnpm-store/
.yarn/
.npm/
vendor/

# Build outputs

dist/
build/
out/
coverage/
.turbo/
.next/
.cache/
.vite/
.esbuild/

# Binary / DB / WAL junk

**/\*.db
**/_.sqlite
\*\*/_.sqlite3
**/\*.wal
**/_.log
\*\*/_.bin \*_/_.tmp

# OS + editor junk

.DS_Store
Thumbs.db
.vscode/
.idea/
\*.swp

# Git + CI metadata

.git/
.github/
.changeset/
.husky/

# Releases / artifacts

releases/
vsix-check/
\*.vsix

# Large generated folders

webview-ui/dist/
apps/**/dist/
apps/**/build/
packages/**/dist/
packages/**/build/

# Env & secrets

.env
.env.\*
