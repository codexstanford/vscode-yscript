import * as z3 from 'z3-solver';

import * as ast from './ast';

export enum Bool {
    true,
    false,
    unknown
}

interface Fact {
    descriptor: string,
    value: Bool
}

export class ProgramState {
    private context: z3.Z3_context;
    private solver: z3.Z3_solver;
    private facts = new Map<string, Fact>();
    private waitingForAsync = false;
    
    constructor(
        private readonly z3: z3.Z3LowLevel & z3.Z3HighLevel
    ) {
        const config = z3.Z3.mk_config();
        //z3.Z3.set_param_value(config, 'auto_config', 'false');
        //z3.Z3.set_param_value(config, 'model', 'true');
        //z3.Z3.set_param_value(config, 'proof', 'true');
        //z3.Z3.set_param_value(config, 'unsat_core', 'true');
        this.context = z3.Z3.mk_context(config);
        this.solver = z3.Z3.mk_solver(this.context);
        //this.solver = z3.Z3.mk_solver_for_logic(this.context, z3.Z3.mk_string_symbol(this.context, 'QF_FD'));
        const x = z3.Z3.mk_const(this.context, z3.Z3.mk_string_symbol(this.context, 'x'), z3.Z3.mk_bool_sort(this.context));
        const y = z3.Z3.mk_const(this.context, z3.Z3.mk_string_symbol(this.context, 'y'), z3.Z3.mk_bool_sort(this.context));
        z3.Z3.solver_assert(this.context, this.solver, z3.Z3.mk_implies(this.context, x, y));
        z3.Z3.solver_assert(this.context, this.solver, z3.Z3.mk_eq(this.context, x, z3.Z3.mk_true(this.context)));
        z3.Z3.solver_get_assertions(this.context, this.solver);
        const assumptions = z3.Z3.mk_ast_vector(this.context);
        const variables = z3.Z3.mk_ast_vector(this.context);
        z3.Z3.ast_vector_push(this.context, variables, x);
        z3.Z3.ast_vector_push(this.context, variables, y);
        const consequences = z3.Z3.mk_ast_vector(this.context);
        z3.Z3.solver_get_consequences(this.context, this.solver, assumptions, variables, consequences).then(r => {
            console.log(r);
        }, err => {
            console.log(err);
        });
        // z3.Z3.solver_check_assumptions(this.context, this.solver, []).then(result => {
        //      console.log(result);
        // });
    }

    updateProgram(program: any) {
        //this.solverReset();

        // Add new facts
        Object.keys(program.facts).forEach(factName => {
            this.getFact(factName, true);
        });

        // Remove facts that are no longer in the program
        const newFactNames = new Set(Object.keys(program.facts).map(sanitize));
        const removeFacts: string[] = [];
        this.facts.forEach((_, name) => {
            if (!newFactNames.has(name)) removeFacts.push(name);
        });
        removeFacts.forEach(name => {
            this.facts.delete(name);
        });

        // Add rules
        Object.entries(program.rules).forEach(([_, rule]: [string, any]) => {
            rule.statements.forEach((statement: any) => {
                //this.solverAdd(statement);
            });
        });
    }

    async incorporateFact(factName: string, value: Bool) {
        return this.getConsequencesWithFact(factName, value).then(([sat, consequences]) => {
            const factNamesBySymbol = this.getFactNamesByConstant();
            if (sat === z3.Z3_lbool.Z3_L_FALSE) { // unsat
                // remove conflicting bindings, then retry
                const unsatCore = this.z3.Z3.solver_get_unsat_core(this.context, this.solver);
                for (let i = 0; i < this.z3.Z3.ast_vector_size(this.context, unsatCore); i++) {
                    const ast = this.z3.Z3.ast_vector_get(this.context, unsatCore, i);
                    const factName = factNamesBySymbol.get(ast);
                    if (!factName) throw new Error(`Unfamiliar fact in unsatisfiable core: ${JSON.stringify(ast)}`);
                    this.getFact(factName).value = Bool.false;
                }
                this.getConsequencesWithFact(factName, value);
            }
            if (sat === z3.Z3_lbool.Z3_L_TRUE) {
                // add consequences
                for (let i = 0; i < this.z3.Z3.ast_vector_size(this.context, consequences); i++) {
                    const ast = this.z3.Z3.ast_vector_get(this.context, consequences, i);
                    // ast is of the form `Implies(x, y)`. We want `y`
                    const app = this.z3.Z3.to_app(this.context, ast);
                    const impliedConstant = this.z3.Z3.get_app_arg(this.context, app, 1);
                    const factName = factNamesBySymbol.get(impliedConstant);
                    if (!factName) throw new Error(`Unfamiliar fact in consequences: ${JSON.stringify(ast)}`);
                    this.getFact(factName).value = Bool.true;
                }
            }
        });
    }

    // Get a JSON-compatible representation of current fact values
    extractFacts(): object {
        const facts: any = {};
        for (const [_, fact] of this.facts.entries()) {
            switch (fact.value) {
                case Bool.true:
                    facts[fact.descriptor] = true;
                    break;
                case Bool.false:
                    facts[fact.descriptor] = false;
                    break;
                default:
                    facts[fact.descriptor] = null;
                    break;
            }
        }
        return facts;
    }

    private async getConsequencesWithFact(factName: string, value: Bool): Promise<[z3.Z3_lbool, z3.Z3_ast_vector]> {
        this.z3.Z3.solver_push(this.context, this.solver);

        const fact = this.getFact(factName, true);
        fact.value = value;

        const factAssertions = this.getFactAssertions();
        //const factAssertions = this.z3.Z3.mk_ast_vector(this.context);

        // Assert all fact values
        for (let i = 0; i < this.z3.Z3.ast_vector_size(this.context, factAssertions) - 1; i++) {
            this.z3.Z3.solver_assert(
                this.context,
                this.solver,
                this.z3.Z3.ast_vector_get(this.context, factAssertions, i));
        }

        const consequences = this.z3.Z3.mk_ast_vector(this.context);

        // Check consequences
        return this.z3.Z3.solver_get_consequences(
            this.context,
            this.solver,
            this.z3.Z3.mk_ast_vector(this.context), // empty assumptions
            this.getFactConstants(), // all fact constants
            consequences
        ).then(sat => {
            this.z3.Z3.solver_pop(this.context, this.solver, 1);
            return [sat, consequences];
        }, err => {
            this.z3.Z3.solver_pop(this.context, this.solver, 1);
            return [z3.Z3_lbool.Z3_L_UNDEF, consequences];
        });
    }

    private exprToZ3(expr: any): z3.Z3_ast {
        if (expr.type === 'only_if') {
            const srcExpr = this.exprToZ3(expr.src_expr);
            const destFact = this.exprToZ3(expr.dest_fact);
            return this.z3.Z3.mk_implies(this.context, srcExpr, destFact);
        }
        if (expr.type === 'and_expr') {
            return this.z3.Z3.mk_and(this.context, [
                this.exprToZ3(expr.left),
                this.exprToZ3(expr.right)
            ]);
        }
        if (expr.type === 'or_expr') {
            return this.z3.Z3.mk_or(this.context, [
                this.exprToZ3(expr.left),
                this.exprToZ3(expr.right)
            ]);
        }
        if (expr.type === 'not_expr') {
            return this.z3.Z3.mk_not(this.context, this.exprToZ3(expr.negand));
        }
        if (typeof expr.descriptor === 'string') {
            return this.descriptorToZ3(expr.descriptor);
        }

        throw new Error(`Unknown expression type: ${JSON.stringify(expr)}`);
    }

    private descriptorToZ3(descriptor: string): z3.Z3_ast {
        const symbol = this.z3.Z3.mk_string_symbol(this.context, sanitize(descriptor));
        return this.z3.Z3.mk_const(this.context, symbol, this.z3.Z3.mk_bool_sort(this.context));
    }

    private getFact(descriptor: string, createMissing = false): Fact {
        const factName = sanitize(descriptor);
        let fact = this.facts.get(factName);

        if (!createMissing && !fact) {
            throw new Error(`Missing dest_fact in program state: ${JSON.stringify(descriptor)}`);
        }

        if (!fact) {
            fact = {
                descriptor,
                value: Bool.unknown
            };
            this.facts.set(factName, fact);
        }

        return fact;
    }

    private getFactConstants(): z3.Z3_ast_vector {
        const symbols = this.z3.Z3.mk_ast_vector(this.context);

        this.facts.forEach(fact => {
            this.z3.Z3.ast_vector_push(this.context, symbols, this.descriptorToZ3(fact.descriptor));
        });

        return symbols;
    }

    private getFactAssertions(): z3.Z3_ast_vector {
        const assertions = this.z3.Z3.mk_ast_vector(this.context);

        this.facts.forEach(fact => {
            if (fact.value === Bool.unknown) return;
            
            this.z3.Z3.ast_vector_push(
                this.context,
                assertions,
                this.z3.Z3.mk_eq(
                    this.context, this.descriptorToZ3(fact.descriptor), this.boolToZ3(fact.value)));
        });

        return assertions;
    }

    private getFactNamesByConstant() {
        const facts = new Map<z3.Z3_ast, string>();

        Array.from(this.facts).forEach(([name, fact]) => {
            facts.set(this.descriptorToZ3(fact.descriptor), name);
        });

        return facts;
    }

    private boolToZ3(b: Bool): z3.Z3_ast {
        switch (b) {
            case Bool.unknown: throw new Error("Can't represent 'unknown' directly in Z3.");
            case Bool.true: return this.z3.Z3.mk_true(this.context);
            case Bool.false: return this.z3.Z3.mk_false(this.context);
        }
    }

    private solverReset() {
        this.z3.Z3.solver_reset(this.context, this.solver);
    }

    private solverAdd(expr: ast.YscriptExpression) {
        this.z3.Z3.solver_assert(this.context, this.solver, this.exprToZ3(expr));
    }
}

function sanitize(factName: string) {
    return factName.replace(/ /g, '_');
}

// bring_umbrella, not_bring_umbrella, have_umbrella, not_have_umbrella, might_need_umbrella, sunny, want_tan, raining, might_rain = all_propositions = Bools('bring_umbrella not_bring_umbrella have_umbrella not_have_umbrella might_need_umbrella sunny want_tan raining might_rain')

// solver = SolverFor('QF_FD')

// # solver.add(Implies(Not(bring_umbrella), not_bring_umbrella))
// # solver.add(Implies(Not(have_umbrella), not_have_umbrella))

// solver.add(Implies(And(have_umbrella, might_need_umbrella), bring_umbrella))
// solver.add(Implies(And(sunny, Not(want_tan)), might_need_umbrella))
// solver.add(Implies(raining, might_need_umbrella))
// solver.add(Implies(might_rain, might_need_umbrella))

// solver.add(sunny == True)
// solver.add(have_umbrella == True)

// solver.push()
// print(solver.consequences([], all_propositions))
// solver.pop()

// solver.push()
// print(solver.check(want_tan == False))
// print(solver.model())
// solver.pop()
