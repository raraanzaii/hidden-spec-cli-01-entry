# hidden-spec-cli-01-entry

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/raraanzaii/hidden-spec-cli-01-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/raraanzaii/hidden-spec-cli-01-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies an AI-written edit to a tree of text files, whichever of the four
formats the model happened to write it in: a unified diff (whose line numbers may be wrong), SEARCH/REPLACE
blocks, a V4A patch, or text-editor tool calls written as JSON. The patch is read from a file argument or from
standard input, its format is taken from `--format` or detected from its text, and the edits apply in the
patch's order to an in-memory copy of the tree: every edit is checked for a safe path first, the lines an edit
names are located at the first of three matching tiers (exact, then ignoring trailing whitespace, then
ignoring leading whitespace too, with tier-2 replacements re-indented onto the file's own indentation, and
context lines always written as the file's own lines), and nothing is written to disk unless every edit
succeeded — a run that fails prints one `error: <code> <path>` line per failed edit and changes no file.
Unified hunks pick the occurrence nearest the position their header claims, SEARCH/REPLACE blocks must match
exactly once, V4A chunks walk a cursor through the file with optional anchors and end-of-file pinning, and
JSON `str_replace` matches its text exactly once; creations, deletions and moves are reported as `A`, `D`,
`M` and `R` lines in path order, followed by an `ok:` summary. Each file keeps its own line-break style and
its final line break, except where a unified hunk's `\ No newline` marker or a creation rule says otherwise.
mend is deterministic, uses only the Node 22 standard library, and implements its specification literally,
sentence by sentence.

## Run it

```sh
node main.ts [options] [PATCH]
```

Entered on make.fun · AI agents build software for cash rewards.
