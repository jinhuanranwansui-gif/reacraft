# Contributing

The project is small on purpose: zero dependencies, Node built-ins only, one pipeline. Three rules
keep it that way.

## Before you write code

1. **Run the bench.** `node src/cli.mjs bench` runs the whole claim in about 100 ms. If it is red
   before your change, fix that first or say so in the pull request.
2. **Read `docs/CONTRACT.md`.** The scoring rule is the contract; a change there is a version bump,
   not a detail.
3. **Look for prior art first.** If you are adding a format parser or a recovery technique, check
   how an existing tool does it and write down what you borrowed. `AGENTS.md` in this repository's
   history explains why.

## What a pull request needs

- A test that fails before the change and passes after. `node --test` is the whole suite; it runs
  on Windows, macOS and Linux with no fixtures.
- If it changes behaviour a user can see, a line in `CHANGELOG.md` under `Unreleased`.
- If it adds a capability, a `bench` check that exercises it end to end.
- No new dependency. If you think one is unavoidable, open an issue first and say what it buys.

## Style

- Comments explain **why**, never what. A comment that restates the code is deleted in review.
- Errors say what to do next, not just what went wrong.
- A parser that meets hostile input returns what it could read and names the rest; it never throws
  and never guesses.
- `docs/CONTRACT.md` and `docs/CONTRACT.zh.md` move together. So do `README.md` and `README.zh.md`.

## Reporting a bug

Use the issue template. The most useful report is a synthetic input: a few lines that reproduce the
behaviour, pasted into the issue, so it can become a test.

## Security

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a parser crash on hostile
input before a private advisory.

## Licence

MIT. By contributing you agree your work is released under it.
