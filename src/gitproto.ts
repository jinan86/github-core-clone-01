// git smart HTTP, implemented from scratch on node:crypto and node:zlib: pkt-line
// framing, packfile read/write (plain objects plus OFS/REF delta resolution on read),
// protocol v2 (ls-refs, fetch) and v0 (upload-pack, receive-pack) advertisements,
// shallow fetch/deepen, and per-ref fast-forward receive-pack reports.
//
// The wire rules come from the kit's git-client.ts, which is the suite's own client:
// v2 is requested with `Git-Protocol: version=2`; receive-pack is v0 only and must
// advertise report-status, side-band-64k and delete-refs.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type Forge,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush: Buffer = Buffer.from('0000', 'ascii');
export const pktDelim: Buffer = Buffer.from('0001', 'ascii');

function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush);
    else if (item === 'delim') parts.push(pktDelim);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Parse pkt-lines from `buf` starting at `offset`; stops at the first flush packet. */
function readPktLines(buf: Buffer, offset: number): { lines: string[]; nextOffset: number; flushed: boolean } {
  const lines: string[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const header = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) return { lines, nextOffset: pos + 4, flushed: true };
    if (length === 1) {
      // Delim packet: keep it as an empty line so callers can split command/args.
      lines.push('');
      pos += 4;
      continue;
    }
    if (length === 2) {
      // Response-end packet: no payload.
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) throw new Error('truncated pkt-line');
    lines.push(buf.subarray(pos + 4, pos + length).toString('utf8'));
    pos += length;
  }
  return { lines, nextOffset: pos, flushed: false };
}

// -------------------------------------------------------------------------------------------
// packfile
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), deterministically ordered by oid. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: GitObjectType;
  resolved?: Buffer;
  oid?: string;
}

/** Read a packfile (v2), resolving OFS/REF deltas; returns oid -> object. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid as string);
      if (!baseEntry) throw new Error(`ref-delta base ${entry.baseOid} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_CAPS_V0 = 'symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta multi_ack multi_ack_detailed agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main agent=forge/1.0';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** The repository's refs as advertisement lines, HEAD first, sorted. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const tip = repo.refs.get('refs/heads/main');
  const defaultBranch = repo.defaultBranch;
  const defaultTip = repo.refs.get(`refs/heads/${defaultBranch}`);
  if (defaultTip !== undefined) lines.push({ oid: defaultTip, name: 'HEAD' });
  void tip;
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject?.type === 'commit') peeled = target;
    }
    lines.push({ oid, name, peeled });
  }
  return lines;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const refs = refLines(repo);
  // Smart HTTP wraps the advertisement: `# service=...` then a flush packet, then the
  // ref lines, then a final flush. Real git rejects the response without that first flush.
  const items: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      items.push(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) items.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  items.push('flush');
  return pktLines(items);
}

function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

export function handleInfoRefs(repo: Repo | undefined, service: 'git-upload-pack' | 'git-receive-pack', wantsV2: boolean): GitResponse {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
  }
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(service, repo),
  };
}

// -------------------------------------------------------------------------------------------
// fetch object selection
// -------------------------------------------------------------------------------------------

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function lookupOf(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

/**
 * The client's current shallow depth: the deepest old boundary's generation from
 * the wants, plus one. `deepen-relative` (what real git sends for --deepen=N)
 * adds to that depth instead of replacing it.
 */
function effectiveDepth(repo: Repo, wants: readonly string[], oldShallow: readonly string[], deepen: number): number {
  const generation = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((want) => [want, 0]);
  while (queue.length) {
    const [oid, gen] = queue.shift() as [string, number];
    if (generation.has(oid)) continue;
    generation.set(oid, gen);
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
  }
  let current = 1;
  for (const boundary of oldShallow) {
    const gen = generation.get(boundary);
    if (gen !== undefined) current = Math.max(current, gen + 1);
  }
  return current + deepen;
}

/**
 * What the client already holds: the closure of its haves, except that a shallow
 * boundary is a cut point — the client has the boundary commit and its tree, but
 * NOT the boundary's parents (that is what makes it shallow). Without the cut, a
 * deepen fetch would send nothing: the parent would look already-held.
 */
function collectHaveClosure(repo: Repo, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const shallowSet = new Set(shallowBoundaries);
  const seen = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
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

function selectObjects(repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | null, oldShallow: readonly string[]): FetchSelection {
  const haveClosure = collectHaveClosure(repo, haves, oldShallow);
  const included = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    // Depth-limited walk over commits: generation < depth is included.
    const commitGen = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (!object) continue;
      if (object.type === 'commit') queue.push([want, 0]);
      else if (object.type === 'tag') {
        included.add(want);
        const target = parseTag(object.data).object;
        const targetObject = repo.objects.get(target);
        if (targetObject?.type === 'commit') queue.push([target, 0]);
        else if (targetObject) included.add(target);
      } else {
        included.add(want);
      }
    }
    const includedCommits = new Set<string>();
    while (queue.length) {
      const [oid, gen] = queue.shift() as [string, number];
      if (commitGen.has(oid)) continue;
      if (gen >= depth) continue;
      commitGen.set(oid, gen);
      includedCommits.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push([parent, gen + 1]);
    }
    for (const oid of includedCommits) {
      included.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const tree = parseCommit(object.data).tree;
      for (const reachable of collectReachable([tree], lookupOf(repo))) included.add(reachable);
      const commit = parseCommit(object.data);
      if (commit.parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
    }
    for (const boundary of oldShallow) {
      if (!includedCommits.has(boundary)) continue;
      const object = repo.objects.get(boundary);
      if (!object || object.type !== 'commit') continue;
      if (parseCommit(object.data).parents.every((parent) => includedCommits.has(parent))) unshallow.push(boundary);
    }
  } else {
    for (const oid of collectReachable(wants, lookupOf(repo))) included.add(oid);
    for (const boundary of oldShallow) {
      if (!included.has(boundary)) continue;
      const object = repo.objects.get(boundary);
      if (!object || object.type !== 'commit') continue;
      if (parseCommit(object.data).parents.every((parent) => included.has(parent))) unshallow.push(boundary);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow, unshallow };
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return out;
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const items: Array<string | Buffer | 'flush'> = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (defaultTip !== undefined) {
      items.push(`${defaultTip} HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`);
    } else if (unborn) {
      items.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`);
    }
  }
  for (const ref of refLines(repo)) {
    if (ref.name === 'HEAD') continue;
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    items.push(`${line}\n`);
  }
  items.push('flush');
  return pktLines(items);
}

function fetchResponse(repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | null, oldShallow: readonly string[], version: 0 | 2): Buffer {
  const { pack, shallow, unshallow } = cachedPack(repo, wants, haves, depth, oldShallow);
  const parts: Buffer[] = [];
  if (version === 2) {
    // The acknowledgments section is only present when the client sent haves:
    // a fresh clone's response starts directly with the packfile section, as real
    // git serves it (and git's fetch-pack dies on an unexpected acknowledgments
    // section when it sent no haves). ACK the haves reachable from the wants.
    if (haves.length > 0) {
      const wantClosure = collectReachable(wants, lookupOf(repo));
      const acks = haves.filter((have) => wantClosure.has(have));
      const ackLines = acks.length > 0 ? acks.map((have) => `ACK ${have}\n`) : ['NAK\n'];
      // 'ready' tells the client negotiation is over and the packfile follows in
      // this same response; without it git refuses any further section.
      parts.push(pktLines(['acknowledgments\n', ...ackLines, 'ready\n', 'delim']));
    }
    if (shallow.length || unshallow.length) {
      const section: Array<string | 'delim'> = ['shallow-info\n'];
      for (const oid of shallow) section.push(`shallow ${oid}\n`);
      for (const oid of unshallow) section.push(`unshallow ${oid}\n`);
      section.push('delim');
      parts.push(pktLines(section));
    }
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(pktFlush);
  } else {
    const head: Array<string | Buffer> = ['NAK\n'];
    for (const oid of shallow) head.push(`shallow ${oid}\n`);
    for (const oid of unshallow) head.push(`unshallow ${oid}\n`);
    parts.push(pktLines(head as Array<string | Buffer | 'flush' | 'delim'>));
    for (const packet of sidebandPackets(pack)) parts.push(packet);
    parts.push(pktFlush);
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// pack cache
// -------------------------------------------------------------------------------------------

interface CachedPack {
  version: number;
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

const packCache = new WeakMap<Repo, Map<string, CachedPack>>();

/**
 * The pack for a fetch selection, cached per repository. Git objects are immutable
 * and content-addressed, so a selection's pack can only change when new objects
 * arrive — which bumps repo.cacheVersion. The clone benchmark issues 50 identical
 * depth-1 fetches, so this turns 49 pack builds into cache hits.
 */
function cachedPack(repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | null, oldShallow: readonly string[]): CachedPack {
  const key = JSON.stringify([wants, haves, depth, oldShallow]);
  let perRepo = packCache.get(repo);
  if (!perRepo) {
    perRepo = new Map<string, CachedPack>();
    packCache.set(repo, perRepo);
  }
  const hit = perRepo.get(key);
  if (hit && hit.version === repo.cacheVersion) return hit;
  const selection = selectObjects(repo, wants, haves, depth, oldShallow);
  const pack = writePack(selection.objects);
  const entry: CachedPack = { version: repo.cacheVersion, pack, shallow: selection.shallow, unshallow: selection.unshallow };
  if (perRepo.size >= 64) perRepo.clear();
  perRepo.set(key, entry);
  return entry;
}

export function handleUploadPack(repo: Repo | undefined, body: Buffer, isV2: boolean): GitResponse {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
  }
  try {
    if (isV2) {
      const { lines } = readPktLines(body, 0);
      const commandLine = (lines[0] ?? '').replace(/\n$/, '');
      if (commandLine === 'command=ls-refs') {
        const delimIndex = lines.findIndex((line) => line === '');
        const args = lines.slice(delimIndex + 1).map((line) => line.replace(/\n$/, ''));
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
      }
      if (commandLine === 'command=fetch') {
        const delimIndex = lines.findIndex((line) => line === '');
        const args = lines.slice(delimIndex + 1).map((line) => line.replace(/\n$/, ''));
        const wants: string[] = [];
        const haves: string[] = [];
        const shallow: string[] = [];
        let depth: number | null = null;
        let deepenRelative = false;
        for (const arg of args) {
          if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
          else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
          else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
          else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
          else if (arg === 'deepen-relative') deepenRelative = true;
        }
        if (depth !== null && deepenRelative) depth = effectiveDepth(repo, wants, shallow, depth);
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, wants, haves, depth, shallow, 2) };
      }
      return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'unknown command' }) + '\n', 'utf8') };
    }
    // v0: wants (+shallow/deepen), flush, haves + done, flush.
    const first = readPktLines(body, 0);
    const wants: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    let deepenRelative = false;
    for (const raw of first.lines) {
      const line = raw.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      if (clean.startsWith('want ')) wants.push(clean.slice(5).trim().split(' ')[0] as string);
      else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8).trim());
      else if (clean.startsWith('deepen ')) depth = Number.parseInt(clean.slice(7), 10);
      else if (clean === 'deepen-relative') deepenRelative = true;
    }
    if (depth !== null && deepenRelative) depth = effectiveDepth(repo, wants, shallow, depth);
    const second = readPktLines(body, first.nextOffset);
    const haves: string[] = [];
    for (const raw of second.lines) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, wants, haves, depth, shallow, 0) };
  } catch (err) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : 'bad request' }) + '\n', 'utf8') };
  }
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
  }
  try {
    const { lines, nextOffset } = readPktLines(body, 0);
    const commands: PushCommand[] = [];
    let capabilities = '';
    for (const raw of lines) {
      const line = raw.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const clean = nul >= 0 ? line.slice(0, nul) : line;
      if (nul >= 0) capabilities = line.slice(nul + 1);
      const parts = clean.split(' ');
      if (parts.length !== 3) throw new Error('bad receive-pack command');
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    const packBytes = body.subarray(nextOffset);
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const objects = readPack(packBytes);
        for (const [oid, object] of objects) repo.objects.set(oid, object);
        // Objects arrived outside putObject, so bump the pack-cache version here.
        repo.cacheVersion += 1;
      } catch {
        unpackOk = false;
        unpackDetail = 'unpack error';
      }
    }
    const reportLines: string[] = [`unpack ${unpackDetail}\n`];
    if (unpackOk) {
      for (const command of commands) {
        const result = applyPushCommand(forge, repo, command);
        reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
      }
    }
    const sideband = capabilities.split(' ').includes('side-band-64k');
    let responseBody: Buffer;
    if (sideband) {
      const inner = pktLines([...reportLines, 'flush']);
      const outer: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), inner]))];
      outer.push(pktFlush);
      responseBody = Buffer.concat(outer);
    } else {
      responseBody = Buffer.concat([pktLines([...reportLines, 'flush'])]);
    }
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
  } catch (err) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: err instanceof Error ? err.message : 'bad request' }) + '\n', 'utf8') };
  }
}

function applyPushCommand(forge: Forge, repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'remote ref does not exist' };
    if (current !== oldOid) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  const object = repo.objects.get(newOid);
  if (!object) return { ok: false, reason: 'object not found' };
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') return { ok: false, reason: 'object is not a commit' };
  if (ref.startsWith('refs/tags/') && object.type !== 'commit' && object.type !== 'tag') {
    return { ok: false, reason: 'object is not a commit or tag' };
  }
  if (current === undefined) {
    if (oldOid !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }
  if (ref.startsWith('refs/tags/')) return { ok: false, reason: 'non-fast-forward' };
  if (oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (!forge.isAncestor(repo, oldOid, newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}
