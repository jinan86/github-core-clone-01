// The forge's in-memory store: git objects and refs, repositories, issues, pull
// requests, labels and comments. Everything lives in Maps; nothing touches the disk,
// so a trial is one process with one store. Timestamps come from a logical clock, so
// two runs that serve the same requests in the same order produce identical state.

import { createHash } from 'node:crypto';
import { VIEWER, type ScenarioUser } from './scenario.ts';
import { LogicalClock, displayMessage, globalId, lineDiffCounts } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from roots (commits, tags, trees, blobs). */
export function collectReachable(roots: Iterable<string>, lookup: (oid: string) => GitObject | undefined): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel a tag (recursively) to the commit it points at. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// The domain model
// -------------------------------------------------------------------------------------------

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly createdSeq: number;
  readonly comments: IssueComment[];
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** oid -> object */
  readonly objects: Map<string, GitObject>;
  /** ref name -> oid */
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  nextNumber: number;
  /** Bumped on every object write; lets the git layer cache packs safely. */
  cacheVersion: number;
}

export interface FlatEntry {
  readonly oid: string;
  readonly mode: string;
}

export interface DiffEntry {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly additions: number;
  readonly deletions: number;
}

export class Forge {
  readonly clock = new LogicalClock();
  readonly viewer: ScenarioUser = VIEWER;
  readonly repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 100000;
  nextCommentId = 1;
  nextLabelId = 1;
  seq = 0;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const now = this.clock.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      cacheVersion: 0,
    };
    this.nextRepoId += 1;
    // The empty tree, so an unborn repository has a tree to build on.
    this.putObject(repo, 'tree', Buffer.alloc(0));
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === this.viewer.login) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    repo.objects.set(oid, { type, data });
    repo.cacheVersion += 1;
    return oid;
  }

  emptyTreeOid(repo: Repo): string {
    return hashObject('tree', Buffer.alloc(0));
  }

  // -- refs -----------------------------------------------------------------------------

  /** Resolve a ref-ish to a commit oid: full ref, branch name, or a 40-hex oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid === undefined ? null : oid;
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    return oid === undefined ? null : oid;
  }

  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    return oid === undefined ? null : oid;
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** The default branch's tip, or null when the repository is unborn. */
  defaultTip(repo: Repo): string | null {
    return this.branchTip(repo, repo.defaultBranch);
  }

  // -- commits and trees ------------------------------------------------------------------

  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const who = `${this.viewer.name} <${this.viewer.email}>`;
    const ts = this.clock.nowSec();
    const body = message.endsWith('\n') ? message : `${message}\n`;
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who} ${ts} +0000`, `committer ${who} ${ts} +0000`, '');
    const data = Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8');
    return this.putObject(repo, 'commit', data);
  }

  /** Ancestors of a tip (newest first: depth 0, then 1, ...), each once. */
  commitHistory(repo: Repo, tip: string): string[] {
    const depth = new Map<string, number>();
    const queue: Array<[string, number]> = [[tip, 0]];
    while (queue.length) {
      const [oid, d] = queue.shift() as [string, number];
      if (depth.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      depth.set(oid, d);
      for (const parent of parseCommit(object.data).parents) queue.push([parent, d + 1]);
    }
    return [...depth.entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
  }

  /** The nearest common ancestor of two commits, or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAncestors = new Set(this.commitHistory(repo, a));
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** Flatten a tree into path -> entry, recursively. */
  flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
    const out = new Map<string, FlatEntry>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Rebuild a tree object from a flat path map, storing every intermediate tree. */
  buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, FlatEntry>): string {
    const buildDir = (prefix: string): string => {
      const children = new Map<string, TreeEntry>();
      for (const [path, entry] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          children.set(rest, { mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const dir = rest.slice(0, slash);
          if (!children.has(dir)) {
            const sub = buildDir(prefix === '' ? dir : `${prefix}/${dir}`);
            children.set(dir, { mode: '40000', name: dir, oid: sub });
          }
        }
      }
      const data = buildTree([...children.values()]);
      return this.putObject(repo, 'tree', data);
    };
    return buildDir('');
  }

  treeOfCommit(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  blobText(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  /** Diff two trees (null = the empty tree). */
  diffTrees(repo: Repo, oldTreeOid: string | null, newTreeOid: string | null): DiffEntry[] {
    const oldFlat = oldTreeOid === null ? new Map<string, FlatEntry>() : this.flattenTree(repo, oldTreeOid);
    const newFlat = newTreeOid === null ? new Map<string, FlatEntry>() : this.flattenTree(repo, newTreeOid);
    const paths = new Set([...oldFlat.keys(), ...newFlat.keys()]);
    const out: DiffEntry[] = [];
    for (const path of [...paths].sort()) {
      const oldEntry = oldFlat.get(path);
      const newEntry = newFlat.get(path);
      if (oldEntry && !newEntry) {
        const oldText = this.blobText(repo, oldEntry.oid);
        const counts = lineDiffCounts(oldText, '');
        out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: counts.deletions });
      } else if (!oldEntry && newEntry) {
        const newText = this.blobText(repo, newEntry.oid);
        const counts = lineDiffCounts('', newText);
        out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: counts.additions, deletions: 0 });
      } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
        const counts = lineDiffCounts(this.blobText(repo, oldEntry.oid), this.blobText(repo, newEntry.oid));
        out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions: counts.additions, deletions: counts.deletions });
      }
    }
    return out;
  }

  /**
   * Set (or delete, when content is null) one file in the tree of `baseCommitOid`
   * (null = the empty tree) and return the new root tree oid.
   */
  applyFileToTree(repo: Repo, baseCommitOid: string | null, path: string, content: Buffer | null): string {
    const baseTree = baseCommitOid === null ? this.emptyTreeOid(repo) : (this.treeOfCommit(repo, baseCommitOid) ?? this.emptyTreeOid(repo));
    const flat = this.flattenTree(repo, baseTree);
    if (content === null) {
      flat.delete(path);
    } else {
      const blobOid = this.putObject(repo, 'blob', content);
      flat.set(path, { oid: blobOid, mode: '100644' });
    }
    return this.buildTreeFromFlat(repo, flat);
  }

  // -- issues and pull requests -----------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    this.seq += 1;
    const now = this.clock.nowIso();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      createdSeq: this.seq,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): PullRequest {
    this.seq += 1;
    const now = this.clock.nowIso();
    const pull: PullRequest = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      createdSeq: this.seq,
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The three-way merge check for a pull request. */
  mergeableOf(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    if (pull.state !== 'open') return 'CONFLICTING';
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return 'CONFLICTING';
    const mb = this.mergeBase(repo, headTip, baseTip);
    const mbTree = mb === null ? this.emptyTreeOid(repo) : (this.treeOfCommit(repo, mb) ?? this.emptyTreeOid(repo));
    const headTree = this.treeOfCommit(repo, headTip) ?? this.emptyTreeOid(repo);
    const baseTree = this.treeOfCommit(repo, baseTip) ?? this.emptyTreeOid(repo);
    const headFlat = this.flattenTree(repo, headTree);
    const baseFlat = this.flattenTree(repo, baseTree);
    const mbFlat = this.flattenTree(repo, mbTree);
    const headDiff = this.diffTrees(repo, mbTree, headTree);
    for (const change of headDiff) {
      const baseEntry = baseFlat.get(change.path);
      const mbEntry = mbFlat.get(change.path);
      const headEntry = headFlat.get(change.path);
      const baseOid = baseEntry?.oid ?? null;
      const mbOid = mbEntry?.oid ?? null;
      const headOid = headEntry?.oid ?? null;
      if (baseOid === mbOid) continue; // the base side did not touch it
      if (baseOid === headOid) continue; // both sides made the same change
      return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request: one commit on the base branch whose tree is the base
   * tip's tree with the head's changes applied, parent = the base tip.
   */
  squashMerge(repo: Repo, pull: PullRequest): { sha: string } | { conflict: true } {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return { conflict: true };
    if (this.mergeableOf(repo, pull) === 'CONFLICTING') return { conflict: true };
    const mb = this.mergeBase(repo, headTip, baseTip);
    const mbTree = mb === null ? this.emptyTreeOid(repo) : (this.treeOfCommit(repo, mb) ?? this.emptyTreeOid(repo));
    const headTree = this.treeOfCommit(repo, headTip) ?? this.emptyTreeOid(repo);
    const baseTree = this.treeOfCommit(repo, baseTip) ?? this.emptyTreeOid(repo);
    const merged = this.flattenTree(repo, baseTree);
    for (const change of this.diffTrees(repo, mbTree, headTree)) {
      if (change.status === 'removed') merged.delete(change.path);
      else if (change.newOid !== null) merged.set(change.path, { oid: change.newOid, mode: '100644' });
    }
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const message = `${pull.title} (#${pull.number})`;
    const sha = this.makeCommit(repo, treeOid, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    const now = this.clock.nowIso();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
    pull.mergeCommitSha = sha;
    return { sha };
  }

  // -- global ids -------------------------------------------------------------------------

  repoGlobalId(repo: Repo): string {
    return globalId('Repository', String(repo.id));
  }
  issueGlobalId(repo: Repo, issue: Issue): string {
    return globalId('Issue', `${repo.id}:${issue.number}`);
  }
  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return globalId('PullRequest', `${repo.id}:${pull.number}`);
  }
  commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
  }

  /** Find a repository by its numeric database id. */
  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }
}
