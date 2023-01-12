# yscript Tools for VS Code

![The extension in use. yscript code is displayed in one column on the left, with a graph depicting connections between rules on the right.](/example.png)

## Setup

You need to install the Python bindings to Z3 yourself.

1. Create a virtual environment at the project root: `python -m venv venv` (the name "venv" is important!)
2. Activate the venv: `source venv/bin/activate`
3. Install Z3: `pip install z3-solver`

## References

The [elm-tooling](https://github.com/elm-tooling) projects are highly instructive.