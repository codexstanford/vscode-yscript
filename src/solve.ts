/**
 * @file Utilities for interacting with Z3.
 * 
 * The Node bindings for Z3 include ways to actually run a solver, but I
 * couldn't get them to work. Instead we hand it off to Python, the Z3 bindings
 * for which I could get to work. This is a little clunky but the interface is
 * the same (async) either way, so ¯\_(ツ)_/¯
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import * as z3 from 'z3-solver';

export enum Bool {
    true,
    false,
    unknown
}

/**
 * Determine the consequences of a program and collection of assertions.
 * 
 * @param program A yscript program
 * @param assertions A hash of fact descriptors to values
 * @returns A hash of descriptors to values, or unsat
 */
export async function checkConsequences(
    z3: z3.Z3LowLevel,
    context: vscode.ExtensionContext,
    program: any,
    assertions: any)
{
    const cfg = z3.Z3.mk_config();
    const ctx = z3.Z3.mk_context(cfg);

    const symbolsToDescriptors: any = {};

    // This manual formatting shouldn't be necessary if I added everything into a solver then used
    // solver_to_string, but that gives me declare-fun instead of declare-const for my constants
    // and I can't imagine why. This way is fine too, I guess
    let code = Object.keys(program.facts).map((descriptor: string) => {
        const constant = z3.Z3.ast_to_string(ctx, yscriptExprToZ3(z3, ctx, { descriptor }));
        symbolsToDescriptors[constant] = descriptor;
        return `(declare-const ${constant} Bool)\n`;
    }).join('');

    code += yscriptProgramToZ3(z3, ctx, program).map(ast => {
        return `(assert ${z3.Z3.ast_to_string(ctx, ast)})\n`;
    }).join('');

    Object.entries(assertions).forEach(([descriptor, value]) => {
        code += `(assert (= ${z3.Z3.ast_to_string(ctx, yscriptExprToZ3(z3, ctx, { descriptor }))} ${value ? 'true' : 'false'}))\n`;
    });

    const solverProcess = spawnIncorporateFact(context);
    
    const promise = new Promise(resolve => {
        solverProcess.stdout.on('data', data => {
            const outFacts: any = {};
            const result: any = { facts: outFacts };
            Object.entries(assertions).forEach(([descriptor, value]) => {
                outFacts[descriptor] = {
                    value,
                    source: 'assertion'
                };
            });
            
            const consequences = data
                .toString()
                .trim()
                .split('\n')
                .filter(Boolean);

            if (consequences[0] === 'unsat') {
                result['result'] = 'unsat';
            }

            if (consequences[0] === 'sat') {
                result['result'] = 'sat';
                consequences
                    .slice(1)
                    .forEach((conseqAst: string) => {
                        const negated = conseqAst.startsWith('(not ');
                        const constant = negated ? conseqAst.slice(5, -1) : conseqAst;
                        if (!symbolsToDescriptors[constant]) throw new Error(`Received value for unknown fact "${constant}"`);
                        if (outFacts[symbolsToDescriptors[constant]]) return;
                        outFacts[symbolsToDescriptors[constant]] = {
                            value: negated ? false : true,
                            source: 'consequence'
                        };
                    });
            }
            
            resolve(result);
        });
    });

    console.log(code);

    solverProcess.stdin.write(code, () => {
        solverProcess.stdin.end();
    });

    return promise;
}

function yscriptProgramToZ3(z3: z3.Z3LowLevel, ctx: z3.Z3_context, program: any): z3.Z3_ast[] {
    let assertions: z3.Z3_ast[] = [];

    Object.values(program.rules).forEach((rule: any) => {
        rule.statements.forEach((statement: any) => {
            assertions = assertions.concat(yscriptStatementToZ3(z3, ctx, statement));
        });
    });

    return assertions;
}

function yscriptStatementToZ3(z3: z3.Z3LowLevel, ctx: z3.Z3_context, expr: any): z3.Z3_ast[] {
    if (expr.type === 'if_then') {
        const srcExpr = yscriptExprToZ3(z3, ctx, expr.src_expr);
        const destFact = yscriptExprToZ3(z3, ctx, expr.dest_fact);
        return [z3.Z3.mk_implies(ctx, srcExpr, destFact)];
    }
    if (expr.type === 'only_if') {
        const srcExpr = yscriptExprToZ3(z3, ctx, expr.src_expr);
        const destFact = yscriptExprToZ3(z3, ctx, expr.dest_fact);
        return [
            z3.Z3.mk_implies(ctx, srcExpr, destFact),
            z3.Z3.mk_implies(ctx, z3.Z3.mk_not(ctx, srcExpr), z3.Z3.mk_not(ctx, destFact))
        ];
    }

    throw new Error(`Unknown statement type: ${JSON.stringify(expr)}`);
}

function yscriptExprToZ3(z3: z3.Z3LowLevel, ctx: z3.Z3_context, expr: any): z3.Z3_ast {
    if (expr.type === 'and_expr') {
        return z3.Z3.mk_and(ctx, [
            yscriptExprToZ3(z3, ctx, expr.left),
            yscriptExprToZ3(z3, ctx, expr.right)
        ]);
    }
    if (expr.type === 'or_expr') {
        return z3.Z3.mk_or(ctx, [
            yscriptExprToZ3(z3, ctx, expr.left),
            yscriptExprToZ3(z3, ctx, expr.right)
        ]);
    }
    if (expr.type === 'not_expr') {
        return z3.Z3.mk_not(ctx, yscriptExprToZ3(z3, ctx, expr.negand));
    }
    if (typeof expr.descriptor === 'string') {
        return descriptorToZ3(z3, ctx, expr.descriptor);
    }

    throw new Error(`Unknown expression type: ${JSON.stringify(expr)}`);
}

function descriptorToZ3(z3: z3.Z3LowLevel, ctx: z3.Z3_context, descriptor: string): z3.Z3_ast {
    const symbol = z3.Z3.mk_string_symbol(ctx, sanitize(descriptor));
    return z3.Z3.mk_const(ctx, symbol, z3.Z3.mk_bool_sort(ctx));
}

/**
 * @param factName A yscript fact descriptor
 * @returns `factName` made usable as an SMT-LIB2 identifier
 */
function sanitize(factName: string) {
    return factName.replace(/[ '"]/g, '_');
}

/**
 * Start the Python process to run a Z3 solver.
 * Will take SMT-LIB2 on stdin and write results to stdout.
 */
function spawnIncorporateFact(context: vscode.ExtensionContext): ChildProcessWithoutNullStreams {
    const interpreter = path.join(context.extensionPath, 'venv', 'bin', 'python');
    const script = path.join(context.extensionPath, 'incorporate_fact.py');
    return spawn(interpreter, ['-u', script]);
}