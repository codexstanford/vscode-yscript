import os
import sys
from z3 import *

def mk_solver(formula):
    solver = SolverFor('QF_FD')
    #solver.set('sat.core.minimize', True)
    solver.from_string(formula)
    return solver

formula = ''
for line in sys.stdin:
    formula += line

solver = mk_solver(formula)
check_result = solver.check()

if check_result == unknown:
    print('unknown')
    exit(1)

if check_result == unsat:
    print('unsat')
    exit(0)
    # Would be nice to get a core here, but it's somewhat complicated to get Z3
    # configured for that, need to handle assertions and assumptions separately
    # core = solver.unsat_core()
    # print(os.linesep.join([c.sexpr() for c in core]))
    # exit(0)

# Reinitialize solver for consequence check. solver.check() does some weird
# stuff to the state that I don't quite understand, and push() and pop() don't
# work the way I thought. This is the simplest thing
solver = mk_solver(formula)
_, consequences = solver.consequences([], solver.non_units())

print('sat\n' + os.linesep.join([c.children()[1].sexpr() for c in consequences]))

exit(0)
