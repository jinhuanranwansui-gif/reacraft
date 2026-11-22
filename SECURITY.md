# Security policy

## What this project is

ReaCraft reads files. It parses containers (PE, ELF, Mach-O, ZIP family, ASAR, WASM) with its own
code, scores a rebuild tree, and — only when a shield is detected — reconstructs string literals
with arithmetic. It does not execute a target, does not make network calls, and has no
dependencies.

Two behaviours matter for a security review:

1. **`decode` reconstructs masked literals without running the target.** It is arithmetic over
   integer arrays the file itself carries. It does not evaluate target code, does not spawn a
   process, and does not use `eval` or `vm`.
2. **`craft --run` shells out to the craft-anything CLI**, and `rea --deep` shells out to the REA
   CLI. Both are off by default (`craft` is a dry run unless `--run` is passed).

## Reporting a vulnerability

Open a [private security advisory](https://github.com/jinhuanranwansui-gif/reacraft/security/advisories/new)
rather than a public issue. Include:

- the version (`reacraft --version`) and platform
- the smallest input that reproduces it (a file, or a synthetic one built by a script)
- what you expected and what happened

Expect an acknowledgement within a week. If the report is a parser crash on hostile input, that is
in scope and treated as a bug: **every parser here is expected to survive a truncated or malformed
file and say so**, not to throw.

## Out of scope

- A shield defeating the reader. `shield` reports what it could not read; that is the designed
  behaviour, not a vulnerability.
- The accuracy of a score. `docs/CONTRACT.md` describes exactly what is counted; disagreeing with
  the weighting is a discussion, not a report.
- Anything a user does with a target they do not own.
