import { Uri, Webview } from "vscode"
import { Package } from "../../shared/package"
/**
 * A helper function which will get the webview URI of a given file or resource.
 *
 * @remarks This URI can be used within a webview's HTML as a link to the
 * given file/resource.
 *
 * @param webview A reference to the extension webview
 * @param extensionUri The URI of the directory containing the extension
 * @param pathList An array of strings representing the path to a file/resource
 * @returns A URI pointing to the file/resource
 */
export function getUri(webview: Webview, extensionUri: Uri, pathList: string[]) {
	const base = webview.asWebviewUri(Uri.joinPath(extensionUri, ...pathList))
	const url = base.toString()
	const cacheBuster = `v=${encodeURIComponent(Package.version)}`
	const separator = url.includes("?") ? "&" : "?"
	return Uri.parse(url + separator + cacheBuster)
}
