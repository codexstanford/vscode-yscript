import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import * as z3 from 'z3-solver';

import * as ast from './ast';
import * as solve from './solve';
import * as util from './util';

const graphHtmlRelativePath = path.join('node_modules', '@codexstanford', 'logic-graph', 'resources', 'public', 'index.html');
const graphJsRelativePath = path.join('node_modules', '@codexstanford', 'logic-graph', 'resources', 'public', 'js', 'compiled', 'app.js');

let preloadedParser: Parser;
let preloadedZ3: z3.Z3HighLevel & z3.Z3LowLevel;

export async function activate(context: vscode.ExtensionContext) {
	// Register subscriptions
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			'yscript.graph',
			new YscriptGraphEditorProvider(context)));
}

class YscriptGraphEditorProvider implements vscode.CustomTextEditorProvider {
	constructor(private readonly context: vscode.ExtensionContext) { }

	public resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		token: vscode.CancellationToken): void {
		// Initialize tree-sitter parser
		const parserLoad = preloadedParser
            ? Promise.resolve(preloadedParser)
            : loadParser(
                path.join(
                    this.context.extensionPath,
                    'resources',
                    'tree-sitter-yscript.wasm'));

		const z3Load = preloadedZ3
			? Promise.resolve(preloadedZ3)
			: z3.init();

		// Start loading required files
		const rawHtml = fs.readFile(
			path.join(this.context.extensionPath, graphHtmlRelativePath),
			{ encoding: 'utf-8' });
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		const positions = workspaceFolder ? readPositions(workspaceFolder) : Promise.resolve({});

		// Finish graph init
		Promise.all([parserLoad, z3Load, rawHtml, positions])
			.then(([parserResolved, z3Resolved, rawHtmlResolved, positionsResolved]) => {
				webviewPanel.webview.options = { enableScripts: true };
				webviewPanel.webview.html = assembleGraphHtml(
					rawHtmlResolved,
					webviewPanel.webview,
					this.context);

				setGraphPositions(webviewPanel.webview, positionsResolved);

				new GraphEditor(this.context, document, webviewPanel, parserResolved, z3Resolved);
			});
	}
}

class GraphEditor {
	private tree: Parser.Tree;
	private program: any;
	private factAssertions: any = {};
	//private programState: ProgramState;

	constructor(
		private readonly extensionContext: vscode.ExtensionContext,
		private readonly document: vscode.TextDocument,
		private readonly webviewPanel: vscode.WebviewPanel,
		private readonly parser: Parser,
		private readonly z3: z3.Z3HighLevel & z3.Z3LowLevel) {
		// Initialize AST
		this.tree = parser.parse(document.getText());

		// Initialize Z3 solver
		//this.programState = new ProgramState(z3);

		// Listen for text document changes

		const recompile = util.debounce(() => {
			this.program = compileFromAst(this.tree.rootNode.walk());
			// this.programState.updateProgram(this.program);

			updateGraphProgram(webviewPanel.webview, this.program);
		}, 100);

		const textChangeSub = vscode.workspace.onDidChangeTextDocument(
			(evt: vscode.TextDocumentChangeEvent) => {
				if (evt.document.uri.toString() !== document.uri.toString()) return;

				for (const change of evt.contentChanges) {
					this.updateAst(evt.document.getText(), change);
				}

				recompile();
			});

		webviewPanel.onDidDispose(textChangeSub.dispose);

		// Listen for graph editor changes

		const graphChangeSub = webviewPanel.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'appReady':
					// Web app has finished setting up and is ready to receive messages.
					// Set the target language to yscript and send the initial program state.
					initGraphForYscript(this.webviewPanel.webview)
						.then(() => readPositions(vscode.workspace.getWorkspaceFolder(this.document.uri)))
						.then(positions => setGraphPositions(this.webviewPanel.webview, positions))
						.then(() => recompile());
					break;
				case 'positionsEdited':
					const folder = vscode.workspace.getWorkspaceFolder(document.uri);
					// If no workspace, nowhere to store positions.
					// TODO is there a way for the extension to require a workspace?
					if (!folder) return;
					writePositions(folder, message.positions);
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
				case 'incorporateFact': {
					const previousValue = this.factAssertions[message.descriptor];
					let value: solve.Bool = solve.Bool.unknown;
					if (message.value === true) value = solve.Bool.true;
					if (message.value === false) value = solve.Bool.false;

					if (value === solve.Bool.unknown) {
						delete this.factAssertions[message.descriptor];
					} else {
						this.factAssertions[message.descriptor] = message.value;
					}

					solve.incorporateFact(this.z3, this.extensionContext, this.program, this.factAssertions, message.descriptor).then((data: any) => {
						if (data.result === 'unsat') {
							if (previousValue) {
								this.factAssertions[message.descriptor] = previousValue;
							} else {
								delete this.factAssertions[message.descriptor];
							}
						}

						if (data.result === 'sat') {
							updateGraphFacts(this.webviewPanel.webview, data.facts);
						}
					});
					break;
				}
				case 'focusRange': {
					const editor = vscode.window.visibleTextEditors.find(ed => ed.document === document);

					if (editor) {
						const {startPosition, endPosition} = message.range;
						editor.revealRange(ast.toVSRange(message.range));
						editor.selection = new vscode.Selection(
							ast.toVSPosition(startPosition),
							ast.toVSPosition(endPosition));
					}

					break;
				}
				case 'showRange': {
					const editor = vscode.window.visibleTextEditors.find(ed => ed.document === document);

					if (editor) {
						editor.revealRange(ast.toVSRange(message.range));
					}

					break;
				}
				default:
					console.log("Received unrecognized message:", message);
			}
		});

		webviewPanel.onDidDispose(graphChangeSub.dispose);
	}

	private updateAst(fullText: string, change: { range: vscode.Range, text: string }) {
		this.tree.edit(
			ast.getEditFromChange(change, this.tree.rootNode.text)
		);

		this.tree = this.parser.parse(fullText, this.tree);
	}
}

function ensureGetIn(root: any, path: string[]): any {
	if (!path.length) return root;

	const ensured = root[path[0]] || {};
	root[path[0]] = ensured;

	return ensureGetIn(ensured, path.slice(1));
}

function createFact() {
	// Yes, these are two different types, see `astToGraphModel` for details
	return {
		determiners: [],
		requirers: {}
	};
}

/**
 * `node`'s "lineage" is the list of `node`'s ancestors up to the root of the
 * program that are necessary to locate `node`. Not all ancestors are necessary
 * for this (e.g. rule_body nodes convey no information), so not all are
 * included.
 * 
 * @param node A Tree-sitter syntax node
 * @returns An array of the interesting parents of `node`
 */
function findLineage(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
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
			n.type === 'not_expr' ||
			n.type === 'only_if' ||
			n.type === 'rule_definition'
		);
	});
}

/**
 * Convert a node's lineage to a path from the root of the program to that
 * node. This allows you to look up a node given its lineage.
 * 
 * @param lineage As returned by `findLineage` 
 * @returns An array of path segments, depending on the type of each ancestor in `lineage`
 */
function lineageToPath(lineage: Parser.SyntaxNode[]): any[] {
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
			case 'not_expr':
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
					case 'not_expr': {
						path.push('negand');
						break;
					}
				}
				break;
			}
		}
	}

	return path;
}

function gotoPreorderSucc(cursor: Parser.TreeCursor): boolean {
	if (cursor.gotoFirstChild()) return true;
	while (!cursor.gotoNextSibling()) {
		if (!cursor.gotoParent()) return false;
	}
	return true;
}

function compileFromAst(cursor: Parser.TreeCursor, db: any = { rules: {}, facts: {} }) {
	do {
		const currentNode = cursor.currentNode();

		switch (currentNode.type) {
			case 'rule_definition': {
				const nameNode = currentNode.childForFieldName('name');
				if (!nameNode) throw new Error("Found rule with no name");
				const ruleName = nameNode.text;
				db.rules[ruleName] = db.rules[ruleName] || {
					statements: []
				};
				db.rules[ruleName].name = { range: [nameNode.startPosition, nameNode.endPosition] };
				db.rules[ruleName].range = [currentNode.startPosition, currentNode.endPosition];
				break;
			}
			case 'only_if': {
				const destFactNode = currentNode.childForFieldName('dest_fact');
				if (!destFactNode) throw new Error("Found ONLY IF with no dest_fact");
				const descriptor = destFactNode.text;
				db.facts[descriptor] = db.facts[descriptor] || createFact();
				db.facts[descriptor].determiners.push({
					// Take the rule and statement index as a path, rest is irrelevant
					path: lineageToPath(findLineage(destFactNode)).slice(0, 2),
					position: [currentNode.startPosition, currentNode.endPosition]
				});

				const lineage = findLineage(currentNode);
				const ancestorRule = lineage.find(
					node => node.type === 'rule_definition'
				);

				const ancestorRuleName = ancestorRule?.childForFieldName('name')?.text;
				if (!ancestorRuleName) throw new Error("Found rule with no name");

				db.rules[ancestorRuleName].statements.push({
					type: 'only_if',
					dest_fact: {
						descriptor,
						range: [destFactNode.startPosition, destFactNode.endPosition]
					}
				});

				break;
			}
			case 'and_expr':
			case 'or_expr':
			case 'not_expr': {
				const [ruleName, statementIdx, ...exprPath] = lineageToPath(findLineage(currentNode));
				const ancestorStatement = db.rules[ruleName].statements[statementIdx];

				if (!exprPath.length) throw new Error("Path to expression should contain at least src_expr");

				ensureGetIn(ancestorStatement, exprPath).type = currentNode.type;

				break;
			}
			case 'fact_expr': {
				const descriptor = currentNode.text;
				const lineage = findLineage(currentNode);
				const [ruleName, statementIdx, ...exprPath] = lineageToPath(lineage);

				// We're going to build up a structure like e.g.
				//   {
				//     "rule a": { 0: {}, 1: {} },
				//     "rule b": { 0: {} }
				//   }
				// We can flatten this into a list of [rule, statementIdx] paths once
				// we've gone through the whole AST.
				db.facts[descriptor] = db.facts[descriptor] || createFact();
				ensureGetIn(db.facts[descriptor].requirers, [ruleName, statementIdx]);

				const ancestorStatement = db.rules[ruleName].statements[statementIdx];
				const factNode = ensureGetIn(ancestorStatement, exprPath);
				factNode.type = 'fact_expr';
				factNode.descriptor = descriptor;
				factNode.range = [currentNode.startPosition, currentNode.endPosition];

				break;
			}
		}
	} while (gotoPreorderSucc(cursor));

	// Flatten fact requirer hierarchies
	for (const factName in db.facts) {
		const fact = db.facts[factName];
		const flatRequirers = [];

		for (const ruleName in fact.requirers) {
			const rule = fact.requirers[ruleName];
			for (const statementIdx in rule) {
				flatRequirers.push({ path: [ruleName, parseInt(statementIdx)] });
			}
		}

		fact.requirers = flatRequirers;
	}

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
function assembleGraphHtml(
	htmlString: String,
	webview: vscode.Webview,
	context: vscode.ExtensionContext): string {
	const jsUri = vscode.Uri.file(path.join(context.extensionPath, graphJsRelativePath));
	return htmlString.replace("/js/compiled/app.js", webview.asWebviewUri(jsUri).toString());
}

function initGraphForYscript(webview: vscode.Webview): Thenable<boolean> {
    return webview.postMessage({
        type: 'lide.initForLanguage',
        language: 'yscript'
    }).then(posted => {
		if (!posted) return Promise.reject("Failed to post init message to webview.");
		return posted;
	});
}

function updateGraphProgram(webview: vscode.Webview, program: any): void {
	webview.postMessage({
		'type': 'lide.codeUpdated.yscript',
		'model': program
	});
}

function updateGraphFacts(webview: vscode.Webview, facts: object): void {
	webview.postMessage({
		'type': 'lide.factsUpdated',
		'facts': facts
	});
}

function setGraphPositions(webview: vscode.Webview, positions: any) {
	webview.postMessage({
		'type': 'lide.positionsRead',
		'positions': positions
	});
}

function getPositionsFilePath(folder: vscode.WorkspaceFolder): string {
	return path.join(folder.uri.fsPath, '.lide', 'positions.json');
}

function readPositions(folder: vscode.WorkspaceFolder | undefined) {
    const empty = { rule: {}, fact: {} };

    if (!folder) return Promise.resolve(empty);

	return fs.readFile(getPositionsFilePath(folder), { encoding: 'utf-8' })
		.then(positions => JSON.parse(positions))
		.catch(() => writePositions(folder, {}).then(() => ({})));
}

function writePositions(folder: vscode.WorkspaceFolder, positions: any) {
	return fs.mkdir(path.dirname(getPositionsFilePath(folder)), { recursive: true })
		.then(() => {
			fs.writeFile(getPositionsFilePath(folder), JSON.stringify(positions || {}, null, 2));
		});
}

async function loadParser(wasmPath: string): Promise<Parser> {
	await Parser.init();
	const parser = new Parser();
	// tree-sitter manual notes that wasm is "considerably slower" than using
	// Node bindings, but using the Node bindings from VS Code is a PITA. See:
	// https://github.com/microsoft/vscode/issues/658
	// https://github.com/elm-tooling/elm-language-server/issues/692
	// https://github.com/tree-sitter/node-tree-sitter/issues/111
	// https://stackoverflow.com/questions/45062881/custom-node-version-to-run-vscode-extensions
	const lang = await Parser.Language.load(wasmPath);
	parser.setLanguage(lang);
    return parser;
}
