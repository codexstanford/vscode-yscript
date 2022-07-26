import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import * as TsYs from 'tree-sitter-yscript';
import { parentPort } from 'worker_threads';
import G = require('glob');

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

		// Store document content (for change detection)
		this.ast = parser.parse(document.getText());

		// Set up event listeners

		const textChangeSub = vscode.workspace.onDidChangeTextDocument(
			debounce(
				(evt: vscode.TextDocumentChangeEvent) => {
					if (evt.document.uri.toString() !== document.uri.toString()) return;

					const newAst = parser.parse(document.getText());

					this.ast = newAst;

					console.log("model:", _astToGraphModel(newAst.walk() as TsYs.TreeCursor));

					_updateGraphFromCode(webviewPanel.webview, document.getText());
				}, 100));

		webviewPanel.onDidDispose(textChangeSub.dispose);

		const graphChangeSub = webviewPanel.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'positionsUpdated':
					const folder = vscode.workspace.getWorkspaceFolder(document.uri);
					if (!folder) return;
					_writePositions(folder, message.positions);
					break;
				case 'programUpdated':
					const editor = vscode.window.visibleTextEditors.find(ed => ed.document === document);

					if (editor) {
						editor.edit(eb => {
							eb.replace(
								new vscode.Range(
									document.lineAt(0).range.start,
									document.lineAt(document.lineCount - 1).range.end),
								message.text);
						});
					}
					break;
				default:
					console.log("Received unrecognized message:", message);
			}
		});

		webviewPanel.onDidDispose(graphChangeSub.dispose);

		Promise.all([rawHtml, positions])
			.then(([rawHtmlResolved, positionsResolved]) => {
				webviewPanel.webview.options = { enableScripts: true };
				webviewPanel.webview.html = _assembleGraphHtml(
					rawHtmlResolved,
					webviewPanel.webview,
					this.context);

				_updateGraphFromCode(webviewPanel.webview, document.getText());

				_setGraphPositions(webviewPanel.webview, positionsResolved);
			});
	}
}

function _createFact() {
	return {
		determinings: new Set,
		requirings: new Set
	};
}

function _findAncestry(node: TsYs.SyntaxNode): TsYs.SyntaxNode[] {
	const ancestry = [];
	let currentNode = node;

	while (currentNode.parent) {
		ancestry.unshift(currentNode.parent);
		currentNode = currentNode.parent;
	}

	// Only some ancestors are interesting, so filter the list down to those
	return ancestry.filter(node => {
		return (
			node.type === TsYs.SyntaxType.OnlyIf ||
			node.type === TsYs.SyntaxType.RuleDefinition
		);
	});
}

function _ancestryToPath(ancestors: TsYs.SyntaxNode[]): any[] {
	const path = [];
	for (let i = 0; i < ancestors.length; i++) {
		const currentNode = ancestors[i];
		switch (currentNode.type) {
			case TsYs.SyntaxType.RuleDefinition: {
				path.push(currentNode.nameNode.text);
			}
			case TsYs.SyntaxType.OnlyIf: {
				const parentRule = ancestors[i - 1];
				path.push(parentRule.children.findIndex(child => child === currentNode));
			}
		}
	}

	return path;
}

function _gotoPreorderSucc(cursor: TsYs.TreeCursor): boolean {
    if (cursor.gotoFirstChild())  return true;
    while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return false;
    }
    return true;
}

function _astToGraphModel(cursor: TsYs.TreeCursor, db: any = {}) {
	do {
		const typedCursor = cursor as TsYs.TypedTreeCursor;
		const currentNode = typedCursor.currentNode;

		switch (currentNode.type) {
			case TsYs.SyntaxType.RuleDefinition: {
				const ruleName = currentNode.nameNode.text;
				db.rules[ruleName] = db.rules[ruleName] || {
					statements: []
				};
				break;
			}
			case TsYs.SyntaxType.OnlyIf: {
				const descriptor = currentNode.dest_factNode.text;
				db.facts[descriptor] = db.facts[descriptor] || _createFact();
				db.facts[descriptor].determinings.add(
					[currentNode.startPosition, currentNode.endPosition]
				);

				const ancestry = _findAncestry(currentNode);
				const ancestorRule = ancestry.find(
					node => node.type === TsYs.SyntaxType.RuleDefinition
				) as TsYs.RuleDefinitionNode;

				db.rules[ancestorRule.nameNode.text].statements.push({
					type: 'only-if',
					dest_fact: descriptor 
				});

				break;
			}
			case TsYs.SyntaxType.FactExpr: {
				const descriptor = currentNode.text;

				db.facts[descriptor] = db.facts[descriptor] || _createFact();
				db.facts[descriptor].requirings.add(_ancestryToPath(_findAncestry(currentNode)));

				break;
			}
		}
	} while (_gotoPreorderSucc(cursor));

	return db;
}

function _astToGraphModel2(node: Parser.SyntaxNode) {
	const factExprQ = yscriptLang.query(
		`(fact_expr @fact)`
	);

	const facts: Record<string, any> = {};
	const onlyIfQ = yscriptLang.query(
		`(only_if @onlyIf
			dest_fact: (descriptor) @dest_descriptor)`
	);

	const rules: Record<string, any> = {};
	const ruleQ = yscriptLang.query(
		`(rule_definition @rule
			name: (descriptor) @name)`
	);
	ruleQ.matches(node).forEach(match => {
		const [ruleCapture, nameCapture] = match.captures;
		const ruleName = nameCapture.node.text;
		rules[ruleName] = rules[ruleName] || {
			statements: []
		};

		onlyIfQ.matches(ruleCapture.node).forEach(match => {
			const [onlyIfCapture, destFactCapture] = match.captures;

			const descriptor = destFactCapture.node.text;
			facts[descriptor] = facts[descriptor] || {
				determiners: new Set,
				requirers: new Set
			};
			facts[descriptor].determiners.add(
				[destFactCapture.node.startPosition, destFactCapture.node.endPosition]
			);

			const statement = {
				type: 'only-if',
				dest_fact: descriptor,
				src_expr: {} 
			};
			rules[ruleName].statements.push(statement);

			factExprQ.captures(onlyIfCapture.node).forEach(capture => {
				const descriptor = capture.node.text;
				facts[descriptor] = facts[descriptor] || {
					determiners: new Set,
					requirers: new Set
				};
				facts[descriptor].requirers.add(
					[capture.node.startPosition, capture.node.endPosition]
				);
			});
		});
	});

	return { facts };
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

/** Debounce lifted from Underscore */
function debounce(f: Function, wait: number, immediate = false) {
	let timeout: any;
	return function () {
		var context = this, args = arguments;
		var later = function () {
			timeout = null;
			if (!immediate) f.apply(context, args);
		};
		var callNow = immediate && !timeout;
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
		if (callNow) f.apply(context, args);
	};
};
