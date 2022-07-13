import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const graphHtmlRelativePath = path.join('resources', 'graph', 'index.html');
const graphJsRelativePath = path.join('resources', 'graph', 'js', 'compiled', 'app.js');

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(YscriptGraphEditorProvider.register(context));
}

class YscriptGraphEditorProvider implements vscode.CustomTextEditorProvider {
	constructor(private readonly context: vscode.ExtensionContext) { }

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider('yscript.graph', new YscriptGraphEditorProvider(context));
	}

	public async resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): Promise<void> {
		// Load HTML source from resources
		const html = fs.readFile(
			path.join(this.context.extensionPath, graphHtmlRelativePath),
			{ encoding: 'utf-8' });

		// Show in webview panel
		return html.then(htmlString => {
			webviewPanel.webview.options = { enableScripts: true };
			webviewPanel.webview.html = _assembleGraphHtml(htmlString, webviewPanel.webview, this.context);
		});
	}
}

/**
 * Massages the HTML for the graph app to be usable by vscode. For now this just
 * consists of replacing the hardcoded path to the compiled JS with a
 * vscode-compatible URI.
 * 
 * @param htmlString the raw HTML string as read from disk
 * @param webview the webview into which the HTML will be rendered
 * @returns {string} the HTML with appropriate replacements made
 */
function _assembleGraphHtml(htmlString: String, webview: vscode.Webview, context: vscode.ExtensionContext): string {
	const jsUri = vscode.Uri.file(path.join(context.extensionPath, graphJsRelativePath));
	return htmlString.replace("/js/compiled/app.js", webview.asWebviewUri(jsUri).toString());
}
