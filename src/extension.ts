import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const graphHtmlRelativePath = path.join('resources', 'graph', 'index.html');
const graphJsRelativePath = path.join('resources', 'graph', 'js', 'compiled', 'app.js');

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider('yscript.graph', new YscriptGraphEditorProvider(context)));
}

class YscriptGraphEditorProvider implements vscode.CustomTextEditorProvider {
	constructor(private readonly context: vscode.ExtensionContext) { }

	public resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): void {
		// Start loading HTML source from resources
		const rawHtml = fs.readFile(
			path.join(this.context.extensionPath, graphHtmlRelativePath),
			{ encoding: 'utf-8' });

		const textChangeSub = vscode.workspace.onDidChangeTextDocument(evt => {
			if (evt.document.uri.toString() === document.uri.toString()) {
				_updateGraphFromCode(webviewPanel.webview, document.getText());
			}
		});

		webviewPanel.onDidDispose(textChangeSub.dispose);

		// Render HTML into webview
		rawHtml.then(raw => {
			webviewPanel.webview.options = { enableScripts: true };
			webviewPanel.webview.html = _assembleGraphHtml(raw, webviewPanel.webview, this.context);
			_updateGraphFromCode(webviewPanel.webview, document.getText());
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

function _updateGraphFromCode(webview: vscode.Webview, text: string) {
	webview.postMessage({
		'type': 'yscript.graph.codeUpdated',
		'text': text
	});
}