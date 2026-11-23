// mend — one patch tool for every AI edit format.
//
// mend reads an edit an AI model wrote, in any of the four formats models use — a unified diff (whose line
// numbers may be wrong), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON — and applies
// it to the tree of text files rooted at the working directory. The whole patch applies or none of it does:
// edits run in the patch's order against an in-memory copy of the tree, and the tree is written back only
// when every edit succeeded. Lines an edit names are found at the first of three matching tiers (exact, then
// up to trailing whitespace, then up to indentation), so a model that drifted whitespace still lands its edit.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// Node 22, standard library only. When MAKEFUN_ENV_URL is set this file is being run by the trial harness and
// hands over to runner.ts (kept beside it) instead of acting as the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A whole-run failure: exit 2 with exactly this one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: a code (no-match, ambiguous, missing, exists, unsafe) and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** The patch's lines: its text split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** A path is safe when it is relative, non-empty, and no segment of it is empty, "." or "..". */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// ---------------------------------------------------------------------------
// A file's text as a line model: its lines, its own line break, and whether
// it ends with that break. An empty file has no lines and no final break.
// ---------------------------------------------------------------------------

interface FileModel {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitText(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function joinText(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it. `now` holds every path an edit has set
// (a string for its new text, null for deleted); anything else is read from
// disk once and remembered, so the "before the patch" state stays available
// for the final report even after later edits touch the same path.
// ---------------------------------------------------------------------------

class Tree {
  private readonly before = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [oldPath, newPath], for the R lines of the report. */
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Matching lines at three tiers. Tier 0 is exact; tier 1 also ignores
// trailing spaces and tabs; tier 2 also ignores leading spaces and tabs.
// With --strict only tier 0 is tried. `strict` is set once by the CLI.
// ---------------------------------------------------------------------------

let strictOnly = false;

const tiersToTry = (): number[] => (strictOnly ? [0] : [0, 1, 2]);

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineMatches(fileLine: string, patchLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === patchLine;
  if (tier === 1) return rstrip(fileLine) === rstrip(patchLine);
  return strip(fileLine) === strip(patchLine);
}

/** Every position at or after `from` where the old lines occur in the file's lines at this tier. */
function occurrences(lines: string[], old: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < old.length; k += 1) {
      if (!lineMatches(lines[i + k]!, old[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which the old lines occur at or after `from`, with its positions; null when none does. */
function findTier(lines: string[], old: string[], from = 0): { tier: number; at: number[] } | null {
  for (const tier of tiersToTry()) {
    const at = occurrences(lines, old, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One body line of a hunk or chunk: context (in both old and new), old-only, or new-only. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A "\" line followed this body line in the patch ("\ No newline at end of file"). */
  noEol: boolean;
}

/**
 * The lines a replacement writes over the match at `pos`: context lines are written as the file's own
 * matched lines, never the patch's; at tier 2 every other new line is re-indented — a non-blank new line
 * that starts with the old block's own leading whitespace has that prefix replaced by the file's.
 */
function writtenLines(fileLines: string[], old: string[], body: BodyLine[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  const fLead = tier === 2 ? leadWs(fileLines[pos] ?? '') : '';
  const pLead = tier === 2 ? leadWs(old[0] ?? '') : '';
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (b.kind === 'old') {
      oi += 1;
    } else {
      let t = b.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pLead)) t = fLead + t.slice(pLead.length);
      out.push(t);
    }
  }
  return out;
}

/** Whether a "\" line follows the body's last context or new line (the lines that survive into the result). */
function noEolAfterLastKept(body: BodyLine[]): boolean {
  let v = false;
  for (const b of body) if (b.kind !== 'old') v = b.noEol;
  return v;
}

// ---------------------------------------------------------------------------
// Format detection (used when --format is absent or "auto"): the first of
// the spec's four tests that holds, over the patch's lines.
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  const unified = lines.some(
    (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
  );
  return unified ? 'unified' : null;
}

// ---------------------------------------------------------------------------
// JSON edits: one array of edit objects, or JSON Lines with one object a
// line. An edit object carries a string `path` and a `command`; a wrong
// command or a missing or mistyped key is a parse fault.
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const readExisting = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text); // a JSON create writes its file_text byte for byte
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      // In a CRLF file the text and both strings are read with every \r\n as \n, and written back with \r\n.
      const m = splitText(before);
      const crlf = m.br === '\r\n';
      const lf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const m = splitText(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      const lines = m.lines.slice();
      lines.splice(line, 0, ...add);
      tree.set(p, joinText(lines, m.br, m.final)); // the file's final break stays as it was
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    // Array form: any fault is reported at the line where the array starts.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines form: a line that does not hold one valid edit object faults at that line.
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs. A section starts at a `diff --git a/<X> b/<Y>` line or at a
// `--- `/`+++ ` pair that is not already part of a section's header; its
// header names the old and new paths; its hunks then apply in order, each to
// the result of the ones before it. A section is one edit.
// ---------------------------------------------------------------------------

interface Hunk {
  /** The A of the hunk header `@@ -A[,B] +C[,D] @@` (B and D are not used). */
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null; // null here can also mean /dev/null; hasPair says which
  dashNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const newSection = (): Section => ({
  gitOld: null,
  gitNew: null,
  dashOld: null,
  dashNew: null,
  hasPair: false,
  renameFrom: null,
  renameTo: null,
  newFile: false,
  delFile: false,
  hunks: [],
});

/** A `---`/`+++` path: the text up to the first tab, spaces removed, /dev/null as null, a/ or b/ stripped. */
function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function unifiedEdits(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number.parseInt(m[1]!, 10);
      i += 1;
      // The body: lines starting with ' ', '-', '+' or a backslash, and empty lines (empty context lines).
      // It ends at the first other line, at a diff --git line, or at a --- line followed by a +++ line.
      const raw: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          raw.push(bl);
          i += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop(); // empty lines at a body's end are not part of it
      const body: BodyLine[] = [];
      for (const bl of raw) {
        if (bl.startsWith('\\')) {
          if (body.length > 0) body[body.length - 1]!.noEol = true;
        } else if (bl === '') body.push({ kind: 'ctx', text: '', noEol: false });
        else if (bl.startsWith(' ')) body.push({ kind: 'ctx', text: bl.slice(1), noEol: false });
        else if (bl.startsWith('-')) body.push({ kind: 'old', text: bl.slice(1), noEol: false });
        else body.push({ kind: 'new', text: bl.slice(1), noEol: false });
      }
      sec.hunks.push({ a, body });
      continue;
    }

    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        // A pair that is not part of the current section's header starts a new section.
        if (sec === null || sec.hasPair || sec.hunks.length > 0) {
          sec = newSection();
          sections.push(sec);
        }
        sec.dashOld = headerPath(line.slice(4));
        sec.dashNew = headerPath(next.slice(4));
        sec.hasPair = true;
        i += 2;
        continue;
      }
      // A --- line not followed by a +++ line, inside a section's header, faults at the line after it.
      if (sec !== null && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1; // otherwise it is prose, and ignored
      continue;
    }

    // Header lines before the section's first hunk; anything else is ignored (prose, code fences).
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s));
}

/** The section's paths: the ---/+++ pair first, then the rename lines, then the diff --git paths. */
function sectionPaths(s: Section): { oldP: string | null; newP: string | null } {
  if (s.hasPair) return { oldP: s.dashOld, newP: s.dashNew };
  return { oldP: s.renameFrom ?? s.gitOld, newP: s.renameTo ?? s.gitNew };
}

/** Apply a section's hunks in order to a file model; d tracks the running line drift for hunk positions. */
function applyHunks(model: FileModel, hunks: Hunk[], path: string): FileModel {
  let lines = model.lines.slice();
  let final = model.final;
  let d = 0;
  for (const h of hunks) {
    const old = h.body.filter((b) => b.kind !== 'new').map((b) => b.text);
    if (old.length === 0) {
      // An insertion: the new lines go after the first A + d lines (all of them when the file has fewer).
      const add = h.body.filter((b) => b.kind === 'new').map((b) => b.text);
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...add);
      if (atEnd) final = !noEolAfterLastKept(h.body);
      d += add.length;
      continue;
    }
    const found = findTier(lines, old);
    if (found === null) throw new Fail('no-match', path);
    // Of the occurrences at the tier, take the one whose position is nearest to A - 1 + d; ties go earlier.
    const target = h.a - 1 + d;
    let pos = found.at[0]!;
    for (const p of found.at) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    const written = writtenLines(lines, old, h.body, pos, found.tier);
    const atEnd = pos + old.length === lines.length;
    lines.splice(pos, old.length, ...written);
    if (atEnd) final = !noEolAfterLastKept(h.body);
    d += written.length - old.length;
  }
  return { lines, br: model.br, final };
}

function unifiedSectionEdit(s: Section): Edit {
  const { oldP, newP } = sectionPaths(s);
  const isCreate = oldP === null || s.newFile;
  const isDelete = !isCreate && (newP === null || s.delFile);
  return (tree) => {
    if (isCreate) {
      const p = newP ?? oldP ?? '';
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      // A creation's file is the + lines of all its hunks, in order, with LF breaks; it ends with a line
      // break unless a backslash line follows its last + line.
      const plus: string[] = [];
      let lastNoEol = false;
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') {
            plus.push(b.text);
            lastNoEol = b.noEol;
          }
        }
      }
      tree.set(p, joinText(plus, '\n', plus.length > 0 && !lastNoEol));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null); // a deletion's hunks are not read
      return;
    }
    const from = oldP ?? '';
    const to = newP ?? from;
    if (!safePath(from)) throw new Fail('unsafe', from);
    if (to !== from && !safePath(to)) throw new Fail('unsafe', to);
    const cur = tree.get(from);
    if (cur === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const r = applyHunks(splitText(cur), s.hunks, from);
    const content = joinText(r.lines, r.br, r.final);
    if (to !== from) {
      tree.set(to, content);
      tree.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.set(from, content);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks. The path is the nearest line before the SEARCH
// marker (skipping blank lines and code fences), after the previous block,
// that names one — or the previous block's path. Each block is one edit,
// applied in order; its old lines must occur exactly once at their tier.
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0; // the index just after the previous block's REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let j = Math.max(i, prevEnd); j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rp)));
    prevPath = path;
    prevEnd = rp + 1;
    i = rp + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      // Empty old lines: the block creates the file with the new lines (LF breaks, a final line break).
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, joinText(newLines, '\n', newLines.length > 0));
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const m = splitText(cur);
    const found = findTier(m.lines, oldLines);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    // The replacement as a body of old lines followed by new lines, written by the shared tier machinery.
    const body: BodyLine[] = [
      ...oldLines.map((t) => ({ kind: 'old' as const, text: t, noEol: false })),
      ...newLines.map((t) => ({ kind: 'new' as const, text: t, noEol: false })),
    ];
    const written = writtenLines(m.lines, oldLines, body, pos, found.tier);
    const lines = m.lines.slice();
    lines.splice(pos, oldLines.length, ...written);
    tree.set(path, joinText(lines, m.br, m.final));
  };
}

// ---------------------------------------------------------------------------
// V4A patches. Sections (Add File / Delete File / Update File) sit between
// *** Begin Patch and *** End Patch. An Update File's chunks apply in order
// under a cursor that walks the file; a chunk may be anchored to a line, or
// pinned to the end of the file by a *** End of File line.
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aSectionKind(line: string): 'add' | 'del' | 'upd' | null {
  if (line.startsWith('*** Add File:')) return 'add';
  if (line.startsWith('*** Delete File:')) return 'del';
  if (line.startsWith('*** Update File:')) return 'upd';
  return null;
}

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last <= first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }
    const kind = v4aSectionKind(lines[i]!);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    const path = lines[i]!.slice(lines[i]!.indexOf(':') + 1).trim();
    i += 1;
    const rawStart = i;
    while (i < last && v4aSectionKind(lines[i]!) === null) i += 1;
    const raw = lines.slice(rawStart, i);
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!)) raw.pop(); // a section's trailing blank lines are not part of it
    if (kind === 'add') {
      const content: string[] = [];
      raw.forEach((l, off) => {
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (l === '') content.push('');
        else throw new Exit2(`error: parse ${rawStart + off + 1}`);
      });
      edits.push(v4aAddEdit(path, content));
    } else if (kind === 'del') {
      raw.forEach((l, off) => {
        if (!isBlank(l)) throw new Exit2(`error: parse ${rawStart + off + 1}`); // a Delete File section has no lines
      });
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, parseChunks(raw, rawStart, secLine)));
    }
  }
  return edits;
}

/** An Update File section's chunks, from its raw lines (whose first patch index is rawStart, 0-based). */
function parseChunks(raw: string[], rawStart: number, secLine: number): { moveTo: string | null; chunks: Chunk[] } {
  let moveTo: string | null = null;
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  raw.forEach((line, off) => {
    const lineno = rawStart + off + 1;
    if (off === 0 && line.startsWith('*** Move to:')) {
      moveTo = line.slice(line.indexOf(':') + 1).trim();
      return;
    }
    if (line.startsWith('@@')) {
      cur = { anchor: line.slice(2).trim() || null, body: [], eof: false };
      chunks.push(cur);
      return;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (cur === null) {
        // Only the first chunk may start at a body line.
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineno}`);
        cur = { anchor: null, body: [], eof: false };
        chunks.push(cur);
      }
      if (line === '') cur.body.push({ kind: 'ctx', text: '', noEol: false });
      else if (line.startsWith(' ')) cur.body.push({ kind: 'ctx', text: line.slice(1), noEol: false });
      else if (line.startsWith('-')) cur.body.push({ kind: 'old', text: line.slice(1), noEol: false });
      else cur.body.push({ kind: 'new', text: line.slice(1), noEol: false });
      return;
    }
    if (line.trim() === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, body: [], eof: false };
        chunks.push(cur);
      }
      cur.eof = true;
      cur = null;
      return;
    }
    throw new Exit2(`error: parse ${lineno}`);
  });
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
  return { moveTo, chunks };
}

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    // An added file is its section's lines, ended by a line break.
    tree.set(path, joinText(content, '\n', content.length > 0));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

function v4aUpdateEdit(path: string, parsed: { moveTo: string | null; chunks: Chunk[] }): Edit {
  const { moveTo, chunks } = parsed;
  return (tree) => {
    if (!safePath(path)) throw new Fail('unsafe', path);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safePath(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const m = splitText(cur);
    const lines = m.lines.slice();
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        // Find the first line at or after the cursor equal to the anchor, at the first tier that has one.
        let at = -1;
        for (const tier of tiersToTry()) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (lineMatches(lines[k]!, ch.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const old = ch.body.filter((b) => b.kind !== 'new').map((b) => b.text);
      if (old.length === 0) {
        const add = ch.body.filter((b) => b.kind === 'new').map((b) => b.text);
        const pos = ch.eof ? lines.length : cursor;
        lines.splice(pos, 0, ...add);
        cursor = pos + add.length;
        continue;
      }
      // The first occurrence at or after the cursor, at the first tier with one; an end-of-file chunk
      // takes only an occurrence that ends at the file's last line, at the first tier that has such a one.
      let found: { tier: number; at: number[] } | null = null;
      for (const tier of tiersToTry()) {
        let at = occurrences(lines, old, tier, cursor);
        if (ch.eof) at = at.filter((p) => p + old.length === lines.length);
        if (at.length > 0) {
          found = { tier, at };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.at[0]!;
      const written = writtenLines(lines, old, ch.body, pos, found.tier);
      lines.splice(pos, old.length, ...written);
      cursor = pos + written.length;
    }
    const content = joinText(lines, m.br, m.final);
    if (moveTo !== null) {
      tree.set(moveTo, content);
      tree.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.set(path, content);
    }
  };
}

// ---------------------------------------------------------------------------
// The CLI itself: parse the arguments, read the patch, read it in its
// format, apply its edits to the tree, and report. The exit-2 errors are
// tried in the spec's order — usage, no-patch, format, parse — and a parse
// error is reported before any file is looked at.
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  strictOnly = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const a of args) {
    if (!optionsEnded && a === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strictOnly) {
        strictOnly = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchArg = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1'); // a patch with no edit at all
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  // Apply the edits in order; a failed edit changes nothing and the edits after it still run.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Report every path whose state changed, in byte order of the paths (UTF-8); a successful move that
  // took a file from a path that existed before to one that did not replaces that pair's D and A lines
  // with one R line, sorted by the new path.
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, { was, now });
  }
  const paired = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o === undefined || n === undefined) continue;
    if (o.was !== null && o.now === null && n.was === null && n.now !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      paired.add(oldP);
      paired.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (paired.has(p)) continue;
    rows.push({ key: p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));

  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
