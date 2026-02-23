import { ToolArgs } from "./types"

export function getBrowserActionDescription(args: ToolArgs): string | undefined {
	if (!args.supportsComputerUse) {
		return undefined
	}
	return `## browser_action
Description: Interact with a Puppeteer-controlled browser. Each action (except \`close\`) returns a screenshot and console logs. One action per message.
- Must always start with \`launch\` and end with \`close\`. To visit a new unreachable URL, close first then re-launch.
- While browser is active, only browser_action can be used. Close browser before using other tools.
- Browser resolution: **${args.browserViewportSize}** pixels. Click at the **center** of elements based on the screenshot.
Parameters:
- action: (required) The action to perform. The available actions are:
    * launch: Launch a new Puppeteer-controlled browser instance at the specified URL. This **must always be the first action**.
        - Use with the \`url\` parameter to provide the URL.
        - Ensure the URL is valid and includes the appropriate protocol (e.g. http://localhost:3000/page, file:///path/to/file.html, etc.)
    * hover: Move the cursor to a specific x,y coordinate.
        - Use with the \`coordinate\` parameter to specify the location.
        - Always move to the center of an element (icon, button, link, etc.) based on coordinates derived from a screenshot.
    * click: Click at a specific x,y coordinate.
        - Use with the \`coordinate\` parameter to specify the location.
        - Always click in the center of an element (icon, button, link, etc.) based on coordinates derived from a screenshot.
    * type: Type a string of text on the keyboard. You might use this after clicking on a text field to input text.
        - Use with the \`text\` parameter to provide the string to type.
    * resize: Resize the viewport to a specific w,h size.
        - Use with the \`size\` parameter to specify the new size.
    * scroll_down: Scroll down the page by one page height.
    * scroll_up: Scroll up the page by one page height.
    * close: Close the Puppeteer-controlled browser instance. This **must always be the final browser action**.
        - Example: \`<action>close</action>\`
- url: (optional) Use this for providing the URL for the \`launch\` action.
    * Example: <url>https://example.com</url>
- coordinate: (optional) The X and Y coordinates for \`click\` and \`hover\` actions.
    * Example: <coordinate>450,300</coordinate>
- size: (optional) The width and height for the \`resize\` action.
    * Example: <size>1280,720</size>
- text: (optional) Use this for providing the text for the \`type\` action.
    * Example: <text>Hello, world!</text>
Usage:
<browser_action>
<action>Action to perform (e.g., launch, click, type, scroll_down, scroll_up, close)</action>
<url>URL to launch the browser at (optional)</url>
<coordinate>x,y coordinates (optional)</coordinate>
<text>Text to type (optional)</text>
</browser_action>

Example:
<browser_action>
<action>launch</action>
<url>https://example.com</url>
</browser_action>`
}
