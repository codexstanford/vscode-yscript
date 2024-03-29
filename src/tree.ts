/**
 * @file Utilities for dealing with Tree-sitter syntax trees.
 */

import * as vscode from 'vscode';
import * as ts from 'web-tree-sitter';

export type FactExpression = {
    type: 'fact_expr',
    descriptor: string
};

export type LogicExpression = FactExpression | {
    type: 'and_expr' | 'or_expr',
    left: LogicExpression,
    right: LogicExpression
};

/** Get a Tree-sitter Edit corresponding to a replacement by `change.text` at
 * `change.range` within `text`.
 * 
 * We can use the Edit to update our syntax tree, which is much faster than
 * rebuilding it completely. */
export function getEditFromChange(
    change: { text: string; range: vscode.Range },
    text: string,
): ts.Edit {
    const [startIndex, endIndex] = getIndicesFromRange(
        change.range,
        text,
    );

    return {
        startIndex,
        oldEndIndex: endIndex,
        newEndIndex: startIndex + change.text.length,
        startPosition: toTSPoint(change.range.start),
        oldEndPosition: toTSPoint(change.range.end),
        newEndPosition: toTSPoint(
            addPositions(change.range.start, textToPosition(change.text)),
        ),
    };
}

export function toVSPosition(tsPoint: ts.Point) {
    return new vscode.Position(tsPoint.row, tsPoint.column);
}

export function toVSRange(tsRange: ts.Range) {
    return new vscode.Range(
        new vscode.Position(tsRange.startPosition.row, tsRange.startPosition.column),
        new vscode.Position(tsRange.endPosition.row, tsRange.endPosition.column));
}

function getIndicesFromRange(
    range: vscode.Range,
    text: string,
): [number, number] {
    let startIndex = range.start.character;
    let endIndex = range.end.character;

    const regex = new RegExp(/\r\n|\r|\n/);
    const eolResult = regex.exec(text);

    const lines = text.split(regex);
    const eol = eolResult && eolResult.length > 0 ? eolResult[0] : "";

    for (let i = 0; i < range.end.line; i++) {
        if (i < range.start.line) {
            startIndex += lines[i].length + eol.length;
        }
        endIndex += lines[i].length + eol.length;
    }

    return [startIndex, endIndex];
}

function toTSPoint(position: vscode.Position): ts.Point {
    return { row: position.line, column: position.character };
}

function textToPosition(text: string): vscode.Position {
    const lines = text.split(/\r\n|\r|\n/);

    return new vscode.Position(
        lines.length - 1,
        lines[lines.length - 1].length
    );
}

function addPositions(pos1: vscode.Position, pos2: vscode.Position): vscode.Position {
    return new vscode.Position(
        pos1.line + pos2.line,
        pos1.character + pos2.character
    );
}