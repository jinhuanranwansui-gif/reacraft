# examples/hello

A synthetic target and an incomplete rebuild, so the whole rail can be run in one command
without a real sample:

```bash
REACRAFT_HOME=./tmp node src/cli.mjs all examples/hello/target.txt --name demo --rebuild examples/hello/rebuild
```

What it shows:

- `target.txt` is plain text, so the reader identifies it as `data` and falls back to string
  evidence — the same path a packed or p-code binary takes.
- `rebuild/app.js` carries two of the five literals, so the obligation score is partial and
  `gaps.json` names the three that are missing.
- Nothing here is a claim about behaviour: the source is illustrative, not a working clone.
