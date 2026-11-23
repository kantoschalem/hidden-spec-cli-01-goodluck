// mend: one patch tool for every AI edit format.
// Node 22, standard library only. Behaviour follows SPEC.md.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------- types

interface FileRec {
  lines: string[];
  eol: '\r\n' | '\n';
  endsWithBreak: boolean;
}

type Tree = Map<string, FileRec>;

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

class EditFail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

interface Edit {
  /** Paths the edit names, in order; checked for safety before anything else. */
  paths: string[];
  /** Apply to the tree; throws EditFail on failure. Must leave the tree unchanged on failure. */
  apply: (tree: Tree) => { move?: { old: string; next: string } } | void;
}

// ---------------------------------------------------------------- file model (SPEC section 3)

function parseFileText(text: string): FileRec {
  if (text === '') return { lines: [], eol: '\n', endsWithBreak: false };
  const firstLf = text.indexOf('\n');
  const eol: '\r\n' | '\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(eol);
  const body = endsWithBreak ? text.slice(0, -eol.length) : text;
  return { lines: body.split(eol), eol, endsWithBreak };
}

function serializeFile(f: FileRec): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.endsWithBreak ? f.eol : '');
}

function makeFile(lines: string[], eol: '\r\n' | '\n', endsWithBreak: boolean): FileRec {
  return { lines, eol, endsWithBreak };
}

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  const raw = text.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------- line matching (SPEC section 5)

function trimEndST(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimST(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingST(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

function findOccurrences(O: string[], lines: string[], tier: number, from: number, onlyEndingAtLast = false): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    if (onlyEndingAtLast && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j], lines[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(O: string[], lines: string[], strict: boolean, from: number, onlyEndingAtLast = false): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(O, lines, t, from, onlyEndingAtLast);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of a replacement: context lines point back at their line of O. */
interface NLine {
  text: string;
  /** index into O for a context line, -1 for a fresh line. */
  oIdx: number;
}

function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** Build the replacement lines for a match at pos (O matched lines[pos..pos+O.length-1]). */
function buildReplacement(N: NLine[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  const rep: string[] = [];
  const f = tier === 2 ? leadingST(fileLines[pos]) : '';
  const p = tier === 2 ? leadingST(O[0]) : '';
  for (const nl of N) {
    if (nl.oIdx >= 0) {
      rep.push(fileLines[pos + nl.oIdx]);
    } else if (tier === 2) {
      rep.push(reindent(nl.text, p, f));
    } else {
      rep.push(nl.text);
    }
  }
  return rep;
}

function spliceLines(lines: string[], pos: number, remove: number, insert: string[]): string[] {
  return [...lines.slice(0, pos), ...insert, ...lines.slice(pos + remove)];
}

// ---------------------------------------------------------------- CLI (SPEC section 1)

interface Cli {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Cli | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let positional = false;
  let patchCount = 0;
  for (const a of argv) {
    if (!positional && a === '--') {
      positional = true;
      continue;
    }
    if (!positional && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      patchCount += 1;
      if (patchCount > 1) return null;
      patch = a;
    }
  }
  return { format: format ?? 'auto', check, strict, patch };
}

// ---------------------------------------------------------------- format detection (SPEC section 4)

function isBlank(l: string): boolean {
  return l.trim() === '';
}

function detectFormat(lines: string[]): string | null {
  const first = lines.find((l) => !isBlank(l));
  if (first === undefined) return null;
  if (first.trim() === '*** Begin Patch') return 'v4a';
  const c = first.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- unified diffs (SPEC section 6)

interface HunkBodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** true when this patch line was literally empty (a context line with empty text). */
  empty: boolean;
  /** true when a `\` line follows this body line. */
  backslash: boolean;
}

interface Hunk {
  a: number;
  body: HunkBodyLine[];
}

interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(): UnifiedSection {
  return {
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;

function stripAB(p: string): string {
  if (p.startsWith('a/')) return p.slice(2);
  if (p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Path from a `--- ` / `+++ ` line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0].trim();
  if (raw === '/dev/null') return null;
  return stripAB(raw);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let section: UnifiedSection | null = null;
  let state: 'out' | 'header' | 'body' = 'out';
  let curHunk: Hunk | null = null;

  const flushSection = (): void => {
    if (section) {
      edits.push(buildUnifiedEdit(section, strict));
      section = null;
    }
    curHunk = null;
  };

  const startHunk = (lineNo: number, line: string): void => {
    const m = HUNK_RE.exec(line);
    if (!m || section === null) throw new ParseError(lineNo + 1);
    curHunk = { a: Number(m[1]), body: [] };
    section.hunks.push(curHunk);
    state = 'body';
  };

  const endBody = (): void => {
    if (curHunk) {
      // Empty lines at the end of a body are not part of it.
      while (curHunk.body.length > 0 && curHunk.body[curHunk.body.length - 1].empty) {
        curHunk.body.pop();
      }
      // Mark `\` lines: a `\` line refers to the body line before it.
      const body = curHunk.body;
      for (let k = 0; k < body.length; k++) {
        if (body[k].kind === '\\' && k > 0) body[k - 1].backslash = true;
      }
      // `\` lines are markers, not body lines.
      curHunk.body = body.filter((b) => b.kind !== '\\');
    }
    curHunk = null;
  };

  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (state === 'body') {
      if (line.startsWith('@@')) {
        endBody();
        startHunk(i, line);
        i += 1;
        continue;
      }
      if (
        line.startsWith('diff --git') ||
        (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ '))
      ) {
        // The body ends at a diff --git line, or at a --- line followed by a +++ line.
        endBody();
        state = 'header';
        // Fall through to process this line as outside a body.
      } else if (
        line === '' ||
        line.startsWith(' ') ||
        line.startsWith('-') ||
        line.startsWith('+') ||
        line.startsWith('\\')
      ) {
        if (curHunk) {
          const kind = (line === '' ? ' ' : line[0]) as HunkBodyLine['kind'];
          curHunk.body.push({ kind, text: line === '' ? '' : line.slice(1), empty: line === '', backslash: false });
        }
        i += 1;
        continue;
      } else {
        // Body ends at the first other line.
        endBody();
        state = 'header';
        // Fall through to process this line as outside a body.
      }
    }
    if (line.startsWith('diff --git')) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m || m[1] === '' || m[2] === '') throw new ParseError(i + 1);
      flushSection();
      section = newSection();
      section.diffOld = m[1];
      section.diffNew = m[2];
      state = 'header';
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      // A ---/+++ pair is part of the current section's header while that
      // header has no hunk yet; otherwise it starts a new section.
      if (state === 'header' && section !== null && section.hunks.length === 0) {
        section.pairOld = headerPath(line);
        section.pairNew = headerPath(lines[i + 1]);
        i += 2;
        continue;
      }
      flushSection();
      section = newSection();
      section.pairOld = headerPath(line);
      section.pairNew = headerPath(lines[i + 1]);
      state = 'header';
      i += 2;
      continue;
    }
    if (state === 'header' && section !== null) {
      if (line.startsWith('@@')) {
        startHunk(i, line);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        // A --- line not followed by a +++ line, inside a section's header.
        if (section.hunks.length === 0) throw new ParseError(i + 2);
        // After the hunks it is prose, ignored.
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (section.renameFrom === null) section.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (section.renameTo === null) section.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        section.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        section.deletedFile = true;
        i += 1;
        continue;
      }
      // index, old mode, new mode, similarity/dissimilarity index, Index: and any other line: ignored.
      i += 1;
      continue;
    }
    // state 'out'
    if (line.startsWith('@@')) {
      // A hunk before any section.
      throw new ParseError(i + 1);
    }
    // Prose, code fences and any other line outside a body: ignored.
    i += 1;
  }
  if (state === 'body') endBody();
  flushSection();
  return edits;
}

function hunkON(h: Hunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, oIdx: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, oIdx: -1 });
    }
  }
  return { O, N };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkBackslashAfterLastCtxOrPlus(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k];
    if (b.kind === ' ' || b.kind === '+') return b.backslash;
  }
  return false;
}

/** True when a `\` line follows the hunk's last `+` line. */
function hunkBackslashAfterLastPlus(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k];
    if (b.kind === '+') return b.backslash;
  }
  return false;
}

function buildUnifiedEdit(s: UnifiedSection, strict: boolean): Edit {
  const oldPath = s.pairOld ?? s.renameFrom ?? s.diffOld;
  const newPath = s.pairNew ?? s.renameTo ?? s.diffNew;
  const isCreate = oldPath === null || s.newFile;
  const isDelete = !isCreate && (newPath === null || s.deletedFile);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  const paths: string[] = [];
  if (oldPath !== null) paths.push(oldPath);
  if (newPath !== null && newPath !== oldPath) paths.push(newPath);
  if (isCreate && newPath === null) paths.push('/dev/null');
  if (paths.length === 0) paths.push('/dev/null');

  return {
    paths,
    apply: (tree: Tree) => {
      if (isCreate) {
        const np = newPath as string;
        if (np === null) throw new EditFail('unsafe', '/dev/null');
        if (tree.has(np)) throw new EditFail('exists', np);
        const plusLines: string[] = [];
        for (const h of s.hunks) {
          for (const b of h.body) if (b.kind === '+') plusLines.push(b.text);
        }
        let endsWithBreak = true;
        if (plusLines.length > 0) {
          let lastPlus: HunkBodyLine | null = null;
          for (const h of s.hunks) {
            for (const b of h.body) if (b.kind === '+') lastPlus = b;
          }
          endsWithBreak = !(lastPlus !== null && lastPlus.backslash);
        }
        tree.set(np, makeFile(plusLines, '\n', endsWithBreak));
        return;
      }
      if (isDelete) {
        const op = oldPath as string;
        if (!tree.has(op)) throw new EditFail('missing', op);
        tree.delete(op);
        return;
      }
      const op = oldPath as string;
      const rec = tree.get(op);
      if (!rec) throw new EditFail('missing', op);
      if (isMove) {
        const np = newPath as string;
        if (tree.has(np)) throw new EditFail('exists', np);
      }
      // Apply the hunks to a copy; any failure leaves the section unchanged.
      let lines = [...rec.lines];
      let endsWithBreak = rec.endsWithBreak;
      let d = 0;
      for (const h of s.hunks) {
        const { O, N } = hunkON(h);
        if (O.length === 0) {
          const at = Math.min(h.a + d, lines.length);
          const atEnd = at === lines.length;
          // O is empty, so N holds only `+` lines: written as they are.
          const inserted = N.map((nl) => nl.text);
          lines = spliceLines(lines, at, 0, inserted);
          if (atEnd) endsWithBreak = !hunkBackslashAfterLastPlus(h);
          d += N.length;
          continue;
        }
        const found = findTier(O, lines, strict, 0);
        if (!found) throw new EditFail('no-match', op);
        const targetPos = h.a - 1 + d;
        let best = found.occ[0];
        let bestDist = Math.abs(best - targetPos);
        for (const p of found.occ) {
          const dist = Math.abs(p - targetPos);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const matchedToEnd = best + O.length === lines.length;
        const rep = buildReplacement(N, O, lines, best, found.tier);
        lines = spliceLines(lines, best, O.length, rep);
        if (matchedToEnd) endsWithBreak = !hunkBackslashAfterLastCtxOrPlus(h);
        d += N.length - O.length;
      }
      const next: FileRec = { lines, eol: rec.eol, endsWithBreak };
      if (isMove) {
        const np = newPath as string;
        tree.delete(op);
        tree.set(np, next);
        return { move: { old: op, next: np } };
      }
      tree.set(op, next);
    },
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (SPEC section 7)

interface SRBlock {
  searchLine: number; // 0-based line of the SEARCH marker
  path: string;
  oldLines: string[];
  newLines: string[];
}

function markerEq(line: string, marker: string): boolean {
  return line.replace(/[ \t]+$/, '') === marker;
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | null = null;
  while (i < n) {
    if (!markerEq(lines[i], '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    const searchLine = i;
    // Find ======= then >>>>>>> REPLACE after the SEARCH line.
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < n; j++) {
      if (markerEq(lines[j], '=======')) {
        eq = j;
        break;
      }
      if (markerEq(lines[j], '>>>>>>> REPLACE') || markerEq(lines[j], '<<<<<<< SEARCH')) break;
    }
    if (eq === -1) throw new ParseError(searchLine + 1);
    for (let j = eq + 1; j < n; j++) {
      if (markerEq(lines[j], '>>>>>>> REPLACE')) {
        rep = j;
        break;
      }
      if (markerEq(lines[j], '<<<<<<< SEARCH')) break;
    }
    if (rep === -1) throw new ParseError(searchLine + 1);
    // The path: nearest line before SEARCH, after the previous block's REPLACE
    // (or the start), that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(searchLine + 1);
      path = prevPath;
    }
    blocks.push({
      searchLine,
      path,
      oldLines: lines.slice(searchLine + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => buildSREdit(b, strict));
}

function buildSREdit(b: SRBlock, strict: boolean): Edit {
  return {
    paths: [b.path],
    apply: (tree: Tree) => {
      if (b.oldLines.length === 0) {
        if (tree.has(b.path)) throw new EditFail('exists', b.path);
        tree.set(b.path, makeFile([...b.newLines], '\n', true));
        return;
      }
      const rec = tree.get(b.path);
      if (!rec) throw new EditFail('missing', b.path);
      const found = findTier(b.oldLines, rec.lines, strict, 0);
      if (!found) throw new EditFail('no-match', b.path);
      if (found.occ.length > 1) throw new EditFail('ambiguous', b.path);
      const pos = found.occ[0];
      const N: NLine[] = b.newLines.map((t) => ({ text: t, oIdx: -1 }));
      const rep = buildReplacement(N, b.oldLines, rec.lines, pos, found.tier);
      tree.set(b.path, { lines: spliceLines(rec.lines, pos, b.oldLines.length, rep), eol: rec.eol, endsWithBreak: rec.endsWithBreak });
    },
  };
}

// ---------------------------------------------------------------- V4A patches (SPEC section 8)

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: ' ' | '-' | '+'; text: string; empty: boolean }[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[]; // add: file lines
  chunks: V4AChunk[];
  lineNo: number; // 0-based line of the section header
}

function sectionStart(line: string, marker: string): string | null {
  if (!line.startsWith(marker)) return null;
  const rest = line.slice(marker.length);
  if (rest !== '' && !/^[ \t]/.test(rest)) return null;
  return rest.trim();
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !isBlank(l));
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!isBlank(lines[k])) {
      last = k;
      break;
    }
  }
  if (last === -1 || lines[last].trim() !== '*** End Patch') throw new ParseError(n + 1);

  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  let curChunk: V4AChunk | null = null;

  const trimSectionBlanks = (): void => {
    if (!cur) return;
    if (cur.kind === 'add') {
      while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
    } else if (cur.kind === 'update' && curChunk) {
      while (curChunk.body.length > 0 && curChunk.body[curChunk.body.length - 1].empty) {
        curChunk.body.pop();
      }
    }
  };

  const closeSection = (): void => {
    trimSectionBlanks();
    if (cur) {
      if (cur.kind === 'update' && cur.chunks.length === 0 && cur.moveTo === null) {
        throw new ParseError(cur.lineNo + 1);
      }
      sections.push(cur);
    }
    cur = null;
    curChunk = null;
  };

  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    const trimmed = line.trim();
    if (isBlank(line)) {
      if (cur !== null && cur.kind === 'add') {
        cur.lines.push('');
      } else if (cur !== null && cur.kind === 'update') {
        if (curChunk !== null) {
          curChunk.body.push({ kind: ' ', text: '', empty: true });
        } else if (cur.chunks.length === 0) {
          curChunk = { anchor: null, eof: false, body: [] };
          cur.chunks.push(curChunk);
          curChunk.body.push({ kind: ' ', text: '', empty: true });
        }
        // Otherwise a blank line after an end-of-file chunk: not part of the section.
      }
      // Between sections, or in a delete section: ignored.
      i += 1;
      continue;
    }
    let p: string | null;
    if ((p = sectionStart(line, '*** Add File:')) !== null) {
      closeSection();
      cur = { kind: 'add', path: p, moveTo: null, lines: [], chunks: [], lineNo: i };
      i += 1;
      continue;
    }
    if ((p = sectionStart(line, '*** Delete File:')) !== null) {
      closeSection();
      cur = { kind: 'delete', path: p, moveTo: null, lines: [], chunks: [], lineNo: i };
      i += 1;
      continue;
    }
    if ((p = sectionStart(line, '*** Update File:')) !== null) {
      closeSection();
      cur = { kind: 'update', path: p, moveTo: null, lines: [], chunks: [], lineNo: i };
      i += 1;
      continue;
    }
    if (trimmed === '*** End Patch') break;
    if (cur === null) throw new ParseError(i + 1);
    if (cur.kind === 'add') {
      if (line.startsWith('+')) {
        cur.lines.push(line.slice(1));
        i += 1;
        continue;
      }
      throw new ParseError(i + 1);
    }
    if (cur.kind === 'delete') {
      throw new ParseError(i + 1);
    }
    // update section
    if ((p = sectionStart(line, '*** Move to:')) !== null) {
      if (cur.chunks.length === 0 && curChunk === null && cur.moveTo === null) {
        cur.moveTo = p;
        i += 1;
        continue;
      }
      throw new ParseError(i + 1);
    }
    if (trimmed === '*** End of File') {
      if (!curChunk) throw new ParseError(i + 1);
      curChunk.eof = true;
      curChunk = null;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      cur.chunks.push(curChunk);
      i += 1;
      continue;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (!curChunk) {
        curChunk = { anchor: null, eof: false, body: [] };
        cur.chunks.push(curChunk);
      }
      const kind = (line === '' ? ' ' : line[0]) as ' ' | '-' | '+';
      curChunk.body.push({ kind, text: line === '' ? '' : line.slice(1), empty: line === '' });
      i += 1;
      continue;
    }
    throw new ParseError(i + 1);
  }
  closeSection();
  return sections.map((s) => buildV4AEdit(s, strict));
}

function v4aChunkON(c: V4AChunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of c.body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, oIdx: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else {
      N.push({ text: b.text, oIdx: -1 });
    }
  }
  return { O, N };
}

function buildV4AEdit(s: V4ASection, strict: boolean): Edit {
  const paths = s.moveTo !== null && s.moveTo !== s.path ? [s.path, s.moveTo] : [s.path];
  return {
    paths,
    apply: (tree: Tree) => {
      if (s.kind === 'add') {
        if (tree.has(s.path)) throw new EditFail('exists', s.path);
        tree.set(s.path, makeFile([...s.lines], '\n', true));
        return;
      }
      if (s.kind === 'delete') {
        if (!tree.has(s.path)) throw new EditFail('missing', s.path);
        tree.delete(s.path);
        return;
      }
      const rec = tree.get(s.path);
      if (!rec) throw new EditFail('missing', s.path);
      if (s.moveTo !== null && tree.has(s.moveTo)) throw new EditFail('exists', s.moveTo);
      let lines = [...rec.lines];
      let cursor = 0;
      for (const c of s.chunks) {
        // Anchor: first line at or after the cursor equal to it, first tier with one.
        if (c.anchor !== null) {
          const found = findTier([c.anchor], lines, strict, cursor);
          if (!found) throw new EditFail('no-match', s.path);
          cursor = found.occ[0] + 1;
        }
        const { O, N } = v4aChunkON(c);
        if (O.length === 0) {
          const at = c.eof ? lines.length : cursor;
          lines = spliceLines(lines, at, 0, N.map((nl) => nl.text));
          cursor = at + N.length;
          continue;
        }
        const found = findTier(O, lines, strict, cursor, c.eof);
        if (!found) throw new EditFail('no-match', s.path);
        const pos = found.occ[0];
        const rep = buildReplacement(N, O, lines, pos, found.tier);
        lines = spliceLines(lines, pos, O.length, rep);
        cursor = pos + rep.length;
      }
      const next: FileRec = { lines, eol: rec.eol, endsWithBreak: rec.endsWithBreak };
      if (s.moveTo !== null) {
        tree.delete(s.path);
        tree.set(s.moveTo, next);
        return { move: { old: s.path, next: s.moveTo } };
      }
      tree.set(s.path, next);
    },
  };
}

// ---------------------------------------------------------------- JSON edits (SPEC section 9)

interface JsonEditObj {
  command: string;
  path: string;
  file_text?: unknown;
  old_str?: unknown;
  new_str?: unknown;
  insert_line?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJsonEdit(value: unknown): JsonEditObj | null {
  if (!isRecord(value)) return null;
  if (typeof value.path !== 'string') return null;
  if (typeof value.command !== 'string') return null;
  const cmd = value.command;
  if (cmd === 'create') {
    if (typeof value.file_text !== 'string') return null;
  } else if (cmd === 'str_replace') {
    if (typeof value.old_str !== 'string' || value.old_str === '') return null;
    if (value.new_str !== undefined && typeof value.new_str !== 'string') return null;
  } else if (cmd === 'insert') {
    if (typeof value.insert_line !== 'number' || !Number.isInteger(value.insert_line)) return null;
    if (typeof value.new_str !== 'string') return null;
  } else {
    return null;
  }
  return value as unknown as JsonEditObj;
}

function parseJson(lines: string[]): Edit[] {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx === -1) return [];
  const first = lines[firstIdx].trimStart();
  if (first.startsWith('[')) {
    // Array form: the whole patch is one JSON array; any fault is at its start line.
    let arr: unknown;
    try {
      arr = JSON.parse(lines.join('\n'));
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstIdx + 1);
    const edits: Edit[] = [];
    for (const v of arr) {
      const e = parseJsonEdit(v);
      if (!e) throw new ParseError(firstIdx + 1);
      edits.push(buildJsonEdit(e));
    }
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = parseJsonEdit(v);
    if (!e) throw new ParseError(i + 1);
    edits.push(buildJsonEdit(e));
  }
  return edits;
}

function countOverlapping(hay: string, needle: string): number {
  let count = 0;
  let at = 0;
  for (;;) {
    const p = hay.indexOf(needle, at);
    if (p === -1) return count;
    count += 1;
    at = p + 1;
  }
}

function buildJsonEdit(e: JsonEditObj): Edit {
  return {
    paths: [e.path],
    apply: (tree: Tree) => {
      if (e.command === 'create') {
        if (tree.has(e.path)) throw new EditFail('exists', e.path);
        tree.set(e.path, parseFileText(e.file_text as string));
        return;
      }
      const rec = tree.get(e.path);
      if (!rec) throw new EditFail('missing', e.path);
      if (e.command === 'str_replace') {
        const oldStr = e.old_str as string;
        const newStr = (e.new_str as string | undefined) ?? '';
        if (rec.eol === '\r\n') {
          const normText = serializeFile(rec).replace(/\r\n/g, '\n');
          const normOld = oldStr.replace(/\r\n/g, '\n');
          const normNew = newStr.replace(/\r\n/g, '\n');
          const count = countOverlapping(normText, normOld);
          if (count === 0) throw new EditFail('no-match', e.path);
          if (count > 1) throw new EditFail('ambiguous', e.path);
          const at = normText.indexOf(normOld);
          const out = normText.slice(0, at) + normNew + normText.slice(at + normOld.length);
          tree.set(e.path, parseFileText(out.replace(/\n/g, '\r\n')));
        } else {
          const text = serializeFile(rec);
          const count = countOverlapping(text, oldStr);
          if (count === 0) throw new EditFail('no-match', e.path);
          if (count > 1) throw new EditFail('ambiguous', e.path);
          const at = text.indexOf(oldStr);
          const out = text.slice(0, at) + newStr + text.slice(at + oldStr.length);
          tree.set(e.path, parseFileText(out));
        }
        return;
      }
      // insert
      const insertLine = e.insert_line as number;
      const newStr = e.new_str as string;
      if (insertLine < 0 || insertLine > rec.lines.length) throw new EditFail('no-match', e.path);
      const ins = patchLines(newStr);
      tree.set(e.path, {
        lines: spliceLines(rec.lines, insertLine, 0, ins),
        eol: rec.eol,
        endsWithBreak: rec.endsWithBreak,
      });
    },
  };
}

// ---------------------------------------------------------------- driver (SPEC sections 2 and 10)

function loadTree(cwd: string): { tree: Tree; initial: Map<string, string> } {
  const tree: Tree = new Map();
  const initial = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const p = rel === '' ? name : `${rel}/${name}`;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, p);
      } else if (st.isFile()) {
        const text = readFileSync(full, 'utf8');
        tree.set(p, parseFileText(text));
        initial.set(p, text);
      }
    }
  };
  walk(cwd, '');
  return { tree, initial };
}

function parsePatch(fmt: string, lines: string[], strict: boolean): Edit[] {
  if (fmt === 'unified') return parseUnified(lines, strict);
  if (fmt === 'search-replace') return parseSearchReplace(lines, strict);
  if (fmt === 'v4a') return parseV4A(lines, strict);
  return parseJson(lines);
}

function run(): number {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  let patchText: string;
  if (cli.patch === null || cli.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(cli.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const lines = patchLines(patchText);
  let fmt = cli.format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (!detected) {
      process.stdout.write('error: format\n');
      return 2;
    }
    fmt = detected;
  }
  let edits: Edit[];
  try {
    edits = parsePatch(fmt, lines, cli.strict);
  } catch (e) {
    if (e instanceof ParseError) {
      process.stdout.write(`error: parse ${e.line}\n`);
      return 2;
    }
    throw e;
  }
  if (edits.length === 0) {
    process.stdout.write('error: parse 1\n');
    return 2;
  }

  const cwd = process.cwd();
  const { tree, initial } = loadTree(cwd);

  const failures: { code: string; path: string }[] = [];
  const movePairs: { old: string; next: string }[] = [];
  for (const e of edits) {
    let unsafe: string | null = null;
    for (const p of e.paths) {
      if (!isSafePath(p)) {
        unsafe = p;
        break;
      }
    }
    if (unsafe !== null) {
      failures.push({ code: 'unsafe', path: unsafe });
      continue;
    }
    try {
      const r = e.apply(tree);
      if (r && r.move) movePairs.push(r.move);
    } catch (err) {
      if (err instanceof EditFail) {
        failures.push({ code: err.code, path: err.path });
        continue;
      }
      throw err;
    }
  }

  if (failures.length > 0) {
    let s = '';
    for (const f of failures) s += `error: ${f.code} ${f.path}\n`;
    s += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(s);
    return 1;
  }

  // Success: work out what changed, in byte order of the paths.
  const suppressedD = new Set<string>();
  const suppressedA = new Set<string>();
  const changes: { key: string; line: string }[] = [];
  for (const m of movePairs) {
    if (initial.has(m.old) && !tree.has(m.old) && !initial.has(m.next) && tree.has(m.next)) {
      changes.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      suppressedD.add(m.old);
      suppressedA.add(m.next);
    }
  }
  for (const [p, orig] of initial) {
    if (!tree.has(p)) {
      if (!suppressedD.has(p)) changes.push({ key: p, line: `D ${p}` });
    } else if (serializeFile(tree.get(p) as FileRec) !== orig) {
      changes.push({ key: p, line: `M ${p}` });
    }
  }
  for (const [p] of tree) {
    if (!initial.has(p) && !suppressedA.has(p)) changes.push({ key: p, line: `A ${p}` });
  }
  changes.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  let s = '';
  for (const c of changes) s += `${c.line}\n`;
  s += `ok: ${changes.length} ${changes.length === 1 ? 'file' : 'files'}\n`;
  process.stdout.write(s);

  if (!cli.check) {
    for (const [p] of initial) {
      if (!tree.has(p)) rmSync(join(cwd, ...p.split('/')), { force: true });
    }
    for (const [p, rec] of tree) {
      const text = serializeFile(rec);
      if (initial.get(p) !== text) {
        const f = join(cwd, ...p.split('/'));
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, text);
      }
    }
  }
  return 0;
}

async function start(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    const { runTrial } = await import('./runner.ts');
    await runTrial(envUrl);
  } else {
    process.exitCode = run();
  }
}

start().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 2;
});
