import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';
import * as z3 from 'z3-solver';

import * as tree from './tree';
import * as solve from './solve';
import * as util from './util';

// Load resources for the graph webview directly from the installed package. Gross but simple
const graphHtmlRelativePath = path.join('node_modules', '@codexstanford', 'logic-graph', 'resources', 'public', 'index.html');
const graphJsRelativePath = path.join('node_modules', '@codexstanford', 'logic-graph', 'resources', 'public', 'js', 'compiled', 'app.js');

// Tree-sitter parser and Z3 API can be a bit slow to load. Cache them here
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
		// Initialize Tree-sitter parser
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

		// Load files required for graph webview
		const rawHtml = fs.readFile(
			path.join(this.context.extensionPath, graphHtmlRelativePath),
			{ encoding: 'utf-8' });
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		const positions = workspaceFolder ? readPositions(workspaceFolder) : Promise.resolve({});

		Promise.all([parserLoad, z3Load, rawHtml, positions])
			.then(([parserResolved, z3Resolved, rawHtmlResolved, positionsResolved]) => {
				// Finish initializing webview
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

	constructor(
		private readonly extensionContext: vscode.ExtensionContext,
		private readonly document: vscode.TextDocument,
		private readonly webviewPanel: vscode.WebviewPanel,
		private readonly parser: Parser,
		private readonly z3: z3.Z3HighLevel & z3.Z3LowLevel) {
		// Initialize syntax tree
		this.tree = parser.parse(document.getText());

		// Listen for text document changes and rebuild the yscript CST and program

		const recompile = util.debounce(() => {
			this.program = compileFromCst(this.tree.rootNode.walk());
			updateGraphProgram(webviewPanel.webview, this.program);
		}, 100);

		const textChangeSub = vscode.workspace.onDidChangeTextDocument(
			(evt: vscode.TextDocumentChangeEvent) => {
				if (evt.document.uri.toString() !== document.uri.toString()) return;

				for (const change of evt.contentChanges) {
					this.updateCst(evt.document.getText(), change);
				}

				recompile();
			});

		webviewPanel.onDidDispose(textChangeSub.dispose);

		// Listen for events from graph view

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
				case 'incorporateFact': {
					// Try adding to our collection of fact values

					const previousValue = this.factAssertions[message.descriptor];
					let value = solve.Bool.unknown;
					if (message.value === true) value = solve.Bool.true;
					if (message.value === false) value = solve.Bool.false;

					// Assert unknown = delete
					if (value === solve.Bool.unknown) {
						delete this.factAssertions[message.descriptor];
					} else {
						this.factAssertions[message.descriptor] = message.value;
					}

					// Run the new facts through Z3
					solve.checkConsequences(this.z3, this.extensionContext, this.program, this.factAssertions).then((data: any) => {
						// If the new value can't be satisfiably incorporated, restore the previous value
						if (data.result === 'unsat') {
							if (previousValue) {
								this.factAssertions[message.descriptor] = previousValue;
							} else {
								delete this.factAssertions[message.descriptor];
							}
						}

						// The new value was incorporated: tell the graph about the new inferences
						if (data.result === 'sat') {
							updateGraphFacts(this.webviewPanel.webview, data.facts);
						}
					});
					break;
				}
				case 'focusRange': {
					// Select and reveal a range in the text editor.

					const editor = vscode.window.visibleTextEditors.find(ed => ed.document === document);

					if (editor) {
						const {startPosition, endPosition} = message.range;
						editor.revealRange(tree.toVSRange(message.range));
						editor.selection = new vscode.Selection(
							tree.toVSPosition(startPosition),
							tree.toVSPosition(endPosition));
					}

					break;
				}
				case 'showRange': {
					// Like focusRange, but don't select the text.

					const editor = vscode.window.visibleTextEditors.find(ed => ed.document === document);

					if (editor) {
						editor.revealRange(tree.toVSRange(message.range));
					}

					break;
				}
				default:
					console.warn("Received unrecognized message:", message);
			}
		});

		webviewPanel.onDidDispose(graphChangeSub.dispose);
	}

	private updateCst(fullText: string, change: { range: vscode.Range, text: string }) {
		this.tree.edit(
			tree.getEditFromChange(change, this.tree.rootNode.text)
		);

		this.tree = this.parser.parse(fullText, this.tree);
	}
}

/**
 * Retrieve the value at `path` in `root`, creating parent objects if necessary
 * along the way.
 * 
 * @param path An array of property names
 * @returns root[path[0]]...[path[n]]
 */
function ensureGetIn(root: any, path: string[]): any {
	if (!path.length) return root;

	const ensured = root[path[0]] || {};
	root[path[0]] = ensured;

	return ensureGetIn(ensured, path.slice(1));
}

function createFact() {
	// See `cstToGraphModel` for usage
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
			n.type === 'if_then' ||
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
 * @returns An array of path segments, depending on the type of each ancestor
 * in `lineage`
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
			case 'if_then':
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
					case 'if_then':
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

/**
 * Walk `cursor` pre-order and depth-first.
 * @returns `false` iff every node has been visited
 */
function gotoPreorderSucc(cursor: Parser.TreeCursor): boolean {
	if (cursor.gotoFirstChild()) return true;
	while (!cursor.gotoNextSibling()) {
		if (!cursor.gotoParent()) return false;
	}
	return true;
}

/**
 * @param cursor A Tree-sitter syntax tree
 * @param program Program as compiled so far
 * @returns A usefully-structured yscript program
 */
function compileFromCst(cursor: Parser.TreeCursor, program: any = { rules: {}, facts: {} }) {
	do {
		const currentNode = cursor.currentNode();

		switch (currentNode.type) {
			case 'rule_definition': {
				const nameNode = currentNode.childForFieldName('name');
				if (!nameNode) throw new Error("Found rule with no name");
				const ruleName = nameNode.text;
				program.rules[ruleName] = program.rules[ruleName] || {
					statements: []
				};
				program.rules[ruleName].name = { range: [nameNode.startPosition, nameNode.endPosition] };
				program.rules[ruleName].range = [currentNode.startPosition, currentNode.endPosition];
				break;
			}
			case 'if_then':
			case 'only_if': {
				const destFactNode = currentNode.childForFieldName('dest_fact');
				if (!destFactNode) throw new Error("Found statement with no dest_fact");
				const descriptor = destFactNode.text;
				program.facts[descriptor] = program.facts[descriptor] || createFact();
				program.facts[descriptor].determiners.push({
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

				program.rules[ancestorRuleName].statements.push({
					type: currentNode.type,
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
				const ancestorStatement = program.rules[ruleName].statements[statementIdx];

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
				// we've gone through the whole CST.
				program.facts[descriptor] = program.facts[descriptor] || createFact();
				ensureGetIn(program.facts[descriptor].requirers, [ruleName, statementIdx]);

				const ancestorStatement = program.rules[ruleName].statements[statementIdx];
				const factNode = ensureGetIn(ancestorStatement, exprPath);
				factNode.type = 'fact_expr';
				factNode.descriptor = descriptor;
				factNode.range = [currentNode.startPosition, currentNode.endPosition];

				break;
			}
		}
	} while (gotoPreorderSucc(cursor));

	// Flatten fact requirer hierarchies
	for (const factName in program.facts) {
		const fact = program.facts[factName];
		const flatRequirers = [];

		for (const ruleName in fact.requirers) {
			const rule = fact.requirers[ruleName];
			for (const statementIdx in rule) {
				flatRequirers.push({ path: [ruleName, parseInt(statementIdx)] });
			}
		}

		fact.requirers = flatRequirers;
	}

	return program;
}

/**
 * Massage the HTML for the graph app to be usable by vscode. For now this just
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
