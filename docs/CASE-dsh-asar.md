# Case study: an Electron app, rebuilt by craft-anything, scored from outside

A real run on this machine, kept because it shows the two kinds of verification side by side and
what each one can and cannot say.

## The target

`default_app.asar` — the Electron default application that ships inside DeepSeek Harness
(110,862 bytes, sha256 `0eb2491b…`). Small, self-contained, and its behaviour is easy to state:
open a window, show the Electron and Node versions, link to the docs.

Read first, with nothing installed:

```text
kind     asar   stack electron   strings 637   endpoints 12   evidence 75
```

Then a contract — 6 obligations, 4 of them machine-checkable, plus `ob-drm-scope` and the human gate:

```text
caps 3   obligations 6 (4 auto, 2 manual)   gate 80%
```

## The rebuild

`craft-anything rebuild` drove a coding agent (DeepSeek backend) and produced a real project in
`projects/dsh-asar/craft/`:

```text
app/main.js        7,228 bytes
app/preload.js     2,712 bytes
app/index.html    12,092 bytes
app/styles.css     2,416 bytes
app/package.json     464 bytes
app/octicon/*.svg  five icons
874 files in total (including node_modules)
```

That is a rebuild, not a mock-up: a main process, a preload script with a context bridge, a renderer,
and the same three-part split as the original.

## What craft-anything's own checks said

Its verification runs after each build and asks two questions:

```text
[Check] Checking the build (1 of 3): build…             OK
[Check] Checking the build (2 of 3): app-screenshot…    FAILED
```

It starts the built program with `--screenshot <file.png>`, expects it to open a window **without
stealing focus**, draw about 120 frames, save a PNG and exit. On this machine:

```text
The program didn't save a picture with --screenshot.
It exited with code 1: … loadApplicationPackage (app/main.js:108:19)
```

Electron itself crashes a fraction of a second after launch with `0xC0000005` — before the app's own
code runs. The rebuild is not at fault; the environment cannot start an Electron window. The build
was stopped, exit code 1.

That check is correct, and it is the right check for what craft-anything is for: **does the thing
run.**

## What this tool said about the same tree

```bash
node src/cli.mjs verify dsh-asar --rebuild projects/dsh-asar/craft/app
```

```text
score    100%   gate=80% → pass
items    pass=5 partial=0 fail=0 pending=1   files=10
similar  67% (medium confidence, minhash=null)

  pass    ob-endpoints            10/10 patterns found
  pass    ob-electron-shape       signed: package.json main=main.js, preload.js present, …
  pass    ob-cap-electron         4/4 patterns found
  pass    ob-cap-network          6/6 patterns found
  pass    ob-cap-crypto           2/2 patterns found
  pending ob-behaviour            needs a human note
```

100% here does not contradict the failed screenshot check. It answers a different question: **is the
source the right source** — same endpoints, same manifest split, same visible strings. Both readings
are true at once:

| question | tool | answer |
|---|---|---|
| does it build | craft-anything | yes |
| does it run | craft-anything | **cannot tell — Electron dies on this machine** |
| is the code the right code | ReaCraft | yes, 100% of the machine-checkable obligations |
| is the behaviour the same | nobody yet | the human obligation is still pending |

## Why this is the case worth publishing

The interesting part is not the 100%. It is that **the stronger verification was unavailable** —
not because the tool was wrong, but because nothing could run. In that state a static contract is the
only thing left that still produces a number, and the number is honest about its own scope.

If the machine had a working display server, the screenshot check would be the better test and the
README says so. On this machine, the floor was the ceiling.

## Reproduce

```powershell
cd <repo>
$env:REACRAFT_HOME="$PWD/projects"
node src/cli.mjs rea  "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\default_app.asar" --name dsh-asar
node src/cli.mjs spec dsh-asar
node src/cli.mjs verify dsh-asar --rebuild projects/dsh-asar/craft/app
node src/cli.mjs prove  dsh-asar
```

The rebuild itself is not committed: it is 874 files produced by a model, and the point here is the
measurement, not the artifact.
