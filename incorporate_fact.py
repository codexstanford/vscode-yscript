import os
import sys
from z3 import *

def mk_solver(smt_lib):
    solver = SolverFor('QF_FD')
    solver.set('sat.core.minimize', True)
    solver.from_string(input)
    return solver

input = ''
for line in sys.stdin:
    input += line

solver = mk_solver(input)
sat = solver.check()
if not sat:
    core = solver.unsat_core()
    print(['unsat', os.linesep.join([c.sexpr() for c in core])])
    exit(0)

# Reinitialize solver for consequence check. solver.check() does some weird
# stuff to the state that I don't quite understand, and push() and pop() don't
# work the way I thought. This is the simplest thing
solver = mk_solver(input)
_, consequences = solver.consequences([], solver.non_units())

print(os.linesep.join([c.children()[1].sexpr() for c in consequences]))

exit(0)

# bring_umbrella, not_bring_umbrella, have_umbrella, not_have_umbrella, might_need_umbrella, sunny, want_tan, raining, might_rain = all_propositions = Bools('bring_umbrella not_bring_umbrella have_umbrella not_have_umbrella might_need_umbrella sunny want_tan raining might_rain')

# solver = SolverFor('QF_FD')

# # solver.add(Implies(Not(bring_umbrella), not_bring_umbrella))
# # solver.add(Implies(Not(have_umbrella), not_have_umbrella))

# solver.add(Implies(And(have_umbrella, might_need_umbrella), bring_umbrella))
# solver.add(Implies(And(sunny, Not(want_tan)), might_need_umbrella))
# solver.add(Implies(raining, might_need_umbrella))
# solver.add(Implies(might_rain, might_need_umbrella))

# solver.add(sunny == True)
# solver.add(have_umbrella == True)

# solver.push()
# print(solver.consequences([], all_propositions))
# solver.pop()

# solver.push()
# print(solver.check(want_tan == False))
# print(solver.model())
# solver.pop()
