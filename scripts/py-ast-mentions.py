"""Print True when MARKER survives as an identifier (code, not a string literal or comment) of a Python file."""
import ast
import sys

tree = ast.parse(open(sys.argv[1]).read())
print(any(isinstance(n, ast.Name) and n.id == sys.argv[2] for n in ast.walk(tree)))
