import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';

import * as ast from './ast';
import * as util from './util';

const graphHtmlRelativePath = path.join('resources', 'graph', 'index.html');
const graphJsRelativePath = path.join('resources', 'graph', 'js', 'compiled', 'app.js');

let parser: Parser;
let yscriptLang: Parser.Language;

export async function activate(context: vscode.ExtensionContext) {
	// Initialize tree-sitter parser
	await Parser.init();
	parser = new Parser();
	// tree-sitter manual notes that wasm is "considerably slower" than using
	// Node bindings, but using the Node bindings from VS Code is a PITA. See:
	// https://github.com/microsoft/vscode/issues/658
	// https://github.com/elm-tooling/elm-language-server/issues/692
	// https://github.com/tree-sitter/node-tree-sitter/issues/111
	// https://stackoverflow.com/questions/45062881/custom-node-version-to-run-vscode-extensions
	yscriptLang = await Parser.Language.load(
		path.join(context.extensionPath, "resources", "tree-sitter-yscript.wasm"));
	parser.setLanguage(yscriptLang);

	// Register subscriptions
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			'yscript.graph',
			new YscriptGraphEditorProvider(context)));
}

class YscriptGraphEditorProvider implements vscode.CustomTextEditorProvider {
	// Start with empty AST (better than null)
	private ast: Parser.Tree = parser.parse("");

	constructor(private readonly context: vscode.ExtensionContext) { }

	public resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): void {
		// Start loading required files
		const rawHtml = fs.readFile(
			path.join(this.context.extensionPath, graphHtmlRelativePath),
			{ encoding: 'utf-8' });
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		const positions = workspaceFolder ? _readPositions(workspaceFolder) : Promise.resolve({});

		// Initialize AST
		this.ast = parser.parse(document.getText());

		// Listen for text document changes

		const _rerenderGraph = util.debounce(() => {
			_updateGraphFromParse(webviewPanel.webview, this.ast);
		}, 100);

		const textChangeSub = vscode.workspace.onDidChangeTextDocument(
			(evt: vscode.TextDocumentChangeEvent) => {
				if (evt.document.uri.toString() !== document.uri.toString()) return;

				for (const change of evt.contentChanges) {
					this.updateAst(evt.document.getText(), change);
				}

				_rerenderGraph();
			});

		webviewPanel.onDidDispose(textChangeSub.dispose);

		// Listen for graph editor changes

		const graphChangeSub = webviewPanel.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'positionsEdited':
					const folder = vscode.workspace.getWorkspaceFolder(document.uri);
					// If no workspace, nowhere to store positions.
					// TODO is there a way for the extension to require a workspace?
					if (!folder) return;
					_writePositions(folder, message.positions);
					break;
				case 'editSource': {
					const editor = vscode.window.visibleTextEditors.find(ed => ed.document === document);

					if (editor) {
						// Edit text. This will be picked up by our text document change listener,
						// which will update our AST and then our graph.
						editor.edit(eb => {
							eb.replace(
								ast.toVSRange(message.range),
								message.text
							);
						});
					}
					break;
				}
				case 'showRange': {
					const editor = vscode.window.visibleTextEditors.find(ed => ed.document === document);

					if (editor) {
						editor.revealRange(ast.toVSRange(message.range), vscode.TextEditorRevealType.Default);
					}

					break;
				}
				default:
					console.log("Received unrecognized message:", message);
			}
		});

		webviewPanel.onDidDispose(graphChangeSub.dispose);

		// Finish graph init
		Promise.all([rawHtml, positions])
			.then(([rawHtmlResolved, positionsResolved]) => {
				webviewPanel.webview.options = { enableScripts: true };
				webviewPanel.webview.html = _assembleGraphHtml(
					rawHtmlResolved,
					webviewPanel.webview,
					this.context);

				_setGraphPositions(webviewPanel.webview, positionsResolved);

				_updateGraphFromParse(webviewPanel.webview, this.ast);
			});
	}

	private updateAst(fullText: string, change: { range: vscode.Range, text: string }) {
		this.ast.edit(
			ast.getEditFromChange(change, this.ast.rootNode.text)
		);

		this.ast = parser.parse(fullText, this.ast);
	}
}

function _ensureGetIn(root: any, path: string[]): any {
	if (!path.length) return root;

	const ensured = root[path[0]] || {};
	root[path[0]] = ensured;

	return _ensureGetIn(ensured, path.slice(1));
}

function _createFact() {
	return {
		determiners: new Set,
		requirers: new Set
	};
}

function _findLineage(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
	const lineage = [];

	let currentNode: Parser.SyntaxNode | null = node;
	while (currentNode !== null) {
		lineage.unshift(currentNode);
		currentNode = currentNode.parent;
	}

	// Only some ancestors are interesting, so filter the list down to those
	return lineage.filter(n => {
		return (
			n.id === node.id ||
			n.type === 'and_expr' ||
			n.type === 'or_expr' ||
			n.type === 'only_if' ||
			n.type === 'rule_definition'
		);
	});
}

function _lineageToPath(lineage: Parser.SyntaxNode[]): any[] {
	const path = [];
	for (let i = 0; i < lineage.length; i++) {
		const currentNode = lineage[i];
		switch (currentNode.type) {
			case 'rule_definition': {
				path.push(currentNode.childForFieldName('name')?.text);
				break;
			}
			case 'only_if': {
				path.push(currentNode.parent?.children.findIndex(child => child.id === currentNode.id));
				break;
			}
			case 'and_expr':
			case 'or_expr':
			case 'fact_expr': {
				const parentNode = lineage[i - 1];
				switch (parentNode.type) {
					case 'only_if': {
						path.push('src_expr');
						break;
					}
					case 'and_expr':
					case 'or_expr': {
						const [left, , right] = parentNode.children;
						if (left.id === currentNode.id) {
							path.push('left');
						} else if (right.id === currentNode.id) {
							path.push('right');
						} else {
							throw new Error("Expression didn't match either operand of parent bool_expr");
						}
						break;
					}
				}
			}
		}
	}

	return path;
}

function _gotoPreorderSucc(cursor: Parser.TreeCursor): boolean {
	if (cursor.gotoFirstChild()) return true;
	while (!cursor.gotoNextSibling()) {
		if (!cursor.gotoParent()) return false;
	}
	return true;
}

function _astToGraphModel(cursor: Parser.TreeCursor, db: any = { rules: {}, facts: {} }) {
	do {
		const currentNode = cursor.currentNode();

		switch (currentNode.type) {
			case 'rule_definition': {
				const ruleName = currentNode.childForFieldName('name')?.text;
				if (!ruleName) throw new Error("Found rule with no name");
				db.rules[ruleName] = db.rules[ruleName] || {
					statements: []
				};
				db.rules[ruleName].range = [currentNode.startPosition, currentNode.endPosition];
				break;
			}
			case 'only_if': {
				const destFactNode = currentNode.childForFieldName('dest_fact');
				if (!destFactNode) throw new Error("Found ONLY IF with no dest_fact");
				const descriptor = destFactNode.text;
				db.facts[descriptor] = db.facts[descriptor] || _createFact();
				db.facts[descriptor].determiners.add(
					_lineageToPath(_findLineage(destFactNode))
				);

				const lineage = _findLineage(currentNode);
				const ancestorRule = lineage.find(
					node => node.type === 'rule_definition'
				);

				const ancestorRuleName = ancestorRule?.childForFieldName('name')?.text;
				if (!ancestorRuleName) throw new Error("Found rule with no name");

				db.rules[ancestorRuleName].statements.push({
					type: 'only_if',
					dest_fact: descriptor
				});

				break;
			}
			case 'and_expr':
			case 'or_expr': {
				const [ruleName, statementIdx, ...exprPath] = _lineageToPath(_findLineage(currentNode));
				const ancestorStatement = db.rules[ruleName].statements[statementIdx];

				if (!exprPath.length) throw new Error("Path to expression should contain at least src_expr");

				_ensureGetIn(ancestorStatement, exprPath).type = currentNode.type;

				break;
			}
			case 'fact_expr': {
				const descriptor = currentNode.text;
				const lineage = _findLineage(currentNode);
				const lineagePath = _lineageToPath([...lineage, currentNode]);

				db.facts[descriptor] = db.facts[descriptor] || _createFact();
				db.facts[descriptor].requirers.add({
					path: lineagePath.slice(0, -1),
					position: [currentNode.startPosition, currentNode.endPosition]
				});

				const [ruleName, statementIdx, ...exprPath] = lineagePath;
				const ancestorStatement = db.rules[ruleName].statements[statementIdx];
				const factNode = _ensureGetIn(ancestorStatement, exprPath);
				factNode.type = 'fact_expr';
				factNode.descriptor = descriptor;

				break;
			}
		}
	} while (_gotoPreorderSucc(cursor));

	return db;
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
function _assembleGraphHtml(
	htmlString: String,
	webview: vscode.Webview,
	context: vscode.ExtensionContext): string {
	const jsUri = vscode.Uri.file(path.join(context.extensionPath, graphJsRelativePath));
	return htmlString.replace("/js/compiled/app.js", webview.asWebviewUri(jsUri).toString());
}

function _updateGraphFromParse(webview: vscode.Webview, ast: Parser.Tree): void {
	webview.postMessage({
		'type': 'yscript.graph.codeUpdated',
		'model': _astToGraphModel(ast.rootNode.walk())
	});
}

function _updateGraphFromCode(webview: vscode.Webview, text: string) {
	webview.postMessage({
		'type': 'yscript.graph.codeUpdated',
		'text': text
	});
}

function _setGraphPositions(webview: vscode.Webview, positions: any) {
	webview.postMessage({
		'type': 'yscript.graph.positionsRead',
		'positions': positions
	});
}

function _getPositionsFilePath(folder: vscode.WorkspaceFolder): string {
	return path.join(folder.uri.fsPath, '.lide', 'positions.json');
}

function _readPositions(folder: vscode.WorkspaceFolder) {
	return fs.mkdir(path.dirname(_getPositionsFilePath(folder)), { recursive: true })
		.then(() => fs.readFile(_getPositionsFilePath(folder), { encoding: 'utf-8' }))
		.then(JSON.parse)
		.catch(() => { return {}; });
}

function _writePositions(folder: vscode.WorkspaceFolder, positions: any) {
	return fs.mkdir(path.dirname(_getPositionsFilePath(folder)), { recursive: true })
		.then(() => {
			fs.writeFile(_getPositionsFilePath(folder), JSON.stringify(positions, null, 2));
		});
}
