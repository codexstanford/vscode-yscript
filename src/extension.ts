import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

const graphHtmlRelativePath = path.join('resources', 'graph', 'index.html');
const graphJsRelativePath   = path.join('resources', 'graph', 'js', 'compiled', 'app.js');

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('yscript.graph.show', () => showGraph(context)));
}

function showGraph(context: vscode.ExtensionContext) {
	// Load HTML source from resources
	const html = fs.readFile(
		path.join(context.extensionPath, graphHtmlRelativePath), 
		{ encoding: 'utf-8' });

	// Show in webview panel
	html.then(htmlString => {
		const panel = vscode.window.createWebviewPanel(
			'yscriptGraph',
			"yscript Graph",
			vscode.ViewColumn.Two,
			{ enableScripts: true });

		panel.webview.html = _assembleGraphHtml(htmlString, panel.webview, context);
	});
}

/**
 * Massages the HTML for the graph app to be usable by vscode. For now this just
 * consists of replacing the hardcoded path to the compiled JS with a
 * vscode-compatible URI.
 * 
 * @param htmlString the raw HTML string as read from disk
 * @param webview the webview into which the HTML will be rendered
 * @returns {String} the HTML with appropriate replacements made
 */
function _assembleGraphHtml(htmlString: String, webview: vscode.Webview, context: vscode.ExtensionContext) {
	const jsUri = vscode.Uri.file(path.join(context.extensionPath, graphJsRelativePath));
	return htmlString.replace("/js/compiled/app.js", webview.asWebviewUri(jsUri).toString());
}
