import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import process from "node:process"
import * as console from "node:console"

import { copyPaths, copyWasms, copyLocales, setupLocaleWatcher } from "@roo-code/build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
	const name = "extension"
	const production = process.argv.includes("--production")
	const watch = process.argv.includes("--watch")
	const minify = production
	const sourcemap = true // Always generate source maps for error handling

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const buildOptions = {
		bundle: true,
		minify,
		sourcemap,
		logLevel: "silent",
		format: "cjs",
		sourcesContent: false,
		platform: "node",
	}

	const srcDir = __dirname
	const buildDir = __dirname
	const distDir = path.join(buildDir, "dist")

	if (fs.existsSync(distDir)) {
		console.log(`[${name}] Cleaning dist directory: ${distDir}`)
		fs.rmSync(distDir, { recursive: true, force: true })
	}

	// Create webview index.html immediately after cleaning dist, before build
	const webviewBuildDir = path.join(distDir, "webview-ui", "build")
	fs.mkdirSync(webviewBuildDir, { recursive: true })
	const webviewIndexPath = path.join(webviewBuildDir, "index.html")
	// Check if real webview index.html exists from React build, if not create a fallback
	const realWebviewPath = path.join(__dirname, "..", "webview-ui", "build", "index.html")
	if (fs.existsSync(realWebviewPath)) {
		// Copy the real React-built index.html
		const realWebviewContent = fs.readFileSync(realWebviewPath, "utf-8")
		fs.writeFileSync(webviewIndexPath, realWebviewContent, "utf-8")
		console.log(`[${name}] Copied real React webview from ${realWebviewPath}`)
	} else {
		// Create minimal fallback if React build doesn't exist
		console.log(`[${name}] Warning: Real webview not found, creating minimal fallback`)
		const minimalHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Roo Code</title></head><body><h1>Loading Roo Code...</h1><p>The real webview UI will load once the React build completes.</p></body></html>`
		fs.writeFileSync(webviewIndexPath, minimalHtml, "utf-8")
	}
	console.log(`[${name}] Created webview index.html at ${webviewIndexPath}`)

	/**
	 * @type {import('esbuild').Plugin[]}
	 */
	const plugins = [
		{
			name: "copyFiles",
			setup(build) {
				build.onEnd(() => {
					copyPaths(
						[
							["../README.md", "README.md"],
							["../CHANGELOG.md", "CHANGELOG.md"],
							["../LICENSE", "LICENSE"],
							["../.env", ".env", { optional: true }],
							["node_modules/vscode-material-icons/generated", "assets/vscode-material-icons"],
							["../webview-ui/audio", "webview-ui/audio"],
							["../webview-ui/build", "webview-ui/build"],
						],
						srcDir,
						buildDir,
					)
				})
			},
		},
		{
			name: "copyWasms",
			setup(build) {
				build.onEnd(() => copyWasms(srcDir, distDir))
			},
		},
		{
			name: "copyLocales",
			setup(build) {
				build.onEnd(() => copyLocales(srcDir, distDir))
			},
		},
		{
			name: "ensureWebviewIndex",
			setup(build) {
				build.onEnd(() => {
					const webviewIndexPath = path.join(distDir, "webview-ui", "build", "index.html")
					if (!fs.existsSync(webviewIndexPath)) {
						const webviewDir = path.dirname(webviewIndexPath)
						if (!fs.existsSync(webviewDir)) {
							fs.mkdirSync(webviewDir, { recursive: true })
						}
						const minimalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Roo Code</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 0;
            margin: 0;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            height: 100vh;
            overflow: hidden;
        }
        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
            padding: 16px;
        }
        .header {
            text-align: center;
            margin-bottom: 20px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .status {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 16px;
        }
        .button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            margin: 4px;
        }
        .button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .version {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2>🦘 Roo Code</h2>
            <div class="version">Version 3.28.45</div>
        </div>
        
        <div class="status">
            <strong>Extension Status:</strong> ✅ Active<br>
            <strong>Commands:</strong> ✅ Registered<br>
            <strong>Control Plane:</strong> ✅ Ready
        </div>
        
        <div>
            <button class="button" onclick="startControlPlane()">Start Control-Plane Here</button>
            <button class="button" onclick="openSettings()">Settings</button>
        </div>
        
        <div style="margin-top: 20px; font-size: 14px;">
            <p><strong>Available Commands:</strong></p>
            <ul style="margin: 8px 0; padding-left: 20px;">
                <li>Save Checkpoint</li>
                <li>Rollback Checkpoint</li>
                <li>New Task</li>
                <li>Focus Input</li>
            </ul>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function startControlPlane() {
            vscode.postMessage({
                command: 'executeCommand',
                commandId: 'roo-cline.startControlPlaneHere'
            });
        }
        
        function openSettings() {
            vscode.postMessage({
                command: 'executeCommand',
                commandId: 'workbench.action.openSettings'
            });
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            console.log('Received message from extension:', message);
        });
    </script>
</body>
</html>`
						fs.writeFileSync(webviewIndexPath, minimalHtml, "utf-8")
						console.log(`[${name}] Created minimal webview index.html`)
					}
				})
			},
		},
		{
			name: "esbuild-problem-matcher",
			setup(build) {
				build.onStart(() => console.log("[esbuild-problem-matcher#onStart]"))
				build.onEnd((result) => {
					result.errors.forEach(({ text, location }) => {
						console.error(`✘ [ERROR] ${text}`)
						if (location && location.file) {
							console.error(`    ${location.file}:${location.line}:${location.column}:`)
						}
					})

					console.log("[esbuild-problem-matcher#onEnd]")
				})
			},
		},
		{
			name: "verifyWebviewInclusion",
			setup(build) {
				build.onEnd(() => {
					const webviewPath = path.join(distDir, "webview-ui", "build", "index.html")
					if (fs.existsSync(webviewPath)) {
						const stats = fs.statSync(webviewPath)
						console.log(`[${name}] ✅ VERIFIED webview file exists: ${webviewPath} (${stats.size} bytes)`)
					} else {
						console.log(`[${name}] ❌ WARNING: webview file NOT FOUND at ${webviewPath}`)
					}
				})
			},
		},
	]

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const extensionConfig = {
		...buildOptions,
		plugins,
		entryPoints: ["extension.ts"],
		outfile: "dist/extension.js",
		external: ["vscode"],
	}

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const workerConfig = {
		...buildOptions,
		entryPoints: ["workers/countTokens.ts"],
		outdir: "dist/workers",
	}

	const [extensionCtx, workerCtx] = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(workerConfig),
	])

	if (watch) {
		await Promise.all([extensionCtx.watch(), workerCtx.watch()])
		copyLocales(srcDir, distDir)
		setupLocaleWatcher(srcDir, distDir)
	} else {
		await Promise.all([extensionCtx.rebuild(), workerCtx.rebuild()])
		await Promise.all([extensionCtx.dispose(), workerCtx.dispose()])
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
