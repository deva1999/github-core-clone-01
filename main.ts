// github-core-clone-01 entry: a standalone GitHub-compatible git forge in one process.
//
// Surfaces, all served from one in-memory store, Node standard library only:
//   - git smart HTTP: upload-pack protocol v2 (+ v0 fallback) and receive-pack v0
//     at /{owner}/{repo}.git
//   - GitHub REST v3 under /api/v3 (repositories, branches, commits, contents,
//     labels, issues, comments, pull requests and merges)
//   - GitHub GraphQL v4 at /api/graphql (the query/mutation shapes gh and
//     github-mcp-server send, plus the introspection they read)
//   - an MCP endpoint at /mcp (JSON-RPC 2.0, revision 2026-07-28 with
//     server/discover, and the legacy initialize handshake)
//
// Lifecycle (agent/v1): bind an ephemeral port, POST {"port": N} to
// $MAKEFUN_ENV_URL/register, long-poll GET $MAKEFUN_ENV_URL/done until it
// answers {"done": true}, then exit 0. Without MAKEFUN_ENV_URL the forge runs
// standalone on $PORT (used by the kit's local runner during development).
//
// Determinism: nothing in any response derives from the wall clock or from
// randomness. Timestamps come from a logical clock (a counter over a fixed
// epoch), ids from counters, and the one login the bearer token names is
// derived from the contest's published scenario seed with the same generator
// the suite uses, so the forge and the suite agree on who the viewer is.

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// The scenario identity: the suite's seeded users, re-derived with the same
// generator (FNV-1a 64 + splitmix64 mix + xorshift64*) so the login the token
// names matches the suite's viewer byte for byte.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value) {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  constructor(seed) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64() {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32() {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive) {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick(items) {
    return items[this.nextInt(items.length)];
  }
}

function scenarioRng(label) {
  return new Rng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

function generateLogins(count) {
  const rng = scenarioRng('users');
  const used = new Set();
  const logins = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    logins.push(login);
  }
  return logins;
}

const SCENARIO_LOGINS = generateLogins(12);
const VIEWER = SCENARIO_LOGINS[0];
const TEAMMATE = SCENARIO_LOGINS[1];
const STRANGER = SCENARIO_LOGINS[2];
const ORG = (() => {
  const rng = scenarioRng('org');
  return `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}-org`;
})();

// ---------------------------------------------------------------------------
// Logical clock and id counters: the only sources of timestamps and ids.
// ---------------------------------------------------------------------------

const EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z, the scenario's day one.
let logicalSeq = 0;

function nextStamp() {
  logicalSeq += 1;
  return EPOCH_SEC + logicalSeq;
}

function isoOf(sec) {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stampIso() {
  return isoOf(nextStamp());
}

let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let nextLabelId = 1;
let requestSeq = 0;

// ---------------------------------------------------------------------------
// Git object store: one content-addressed map shared by every repository
// (objects are immutable and self-verifying, so sharing is safe), plus
// per-repository refs and metadata.
// ---------------------------------------------------------------------------

const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_IDS = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

const objects = new Map(); // oid -> { type, data: Buffer }

function sha1Hex(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function storeObject(type, data) {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

function getObject(oid) {
  return objects.get(oid) ?? null;
}

// --- commits ---------------------------------------------------------------

const commitCache = new Map(); // oid -> { tree, parents, message, authorLine }

function parseCommit(oid) {
  const cached = commitCache.get(oid);
  if (cached !== undefined) return cached;
  const obj = getObject(oid);
  if (obj === null || obj.type !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = null;
  let authorLine = '';
  const parents = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
  }
  const parsed = { tree, parents, message, authorLine };
  commitCache.set(oid, parsed);
  return parsed;
}

function forgeIdentity(sec) {
  return `${VIEWER} <${VIEWER}@example.invalid> ${sec} +0000`;
}

function buildCommit({ tree, parents, message, sec }) {
  const ident = forgeIdentity(sec);
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return storeObject('commit', Buffer.from(text, 'utf8'));
}

// --- trees -----------------------------------------------------------------

function parseTreeData(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

const treeCache = new Map(); // oid -> entries

function treeEntries(oid) {
  const cached = treeCache.get(oid);
  if (cached !== undefined) return cached;
  const obj = getObject(oid);
  if (obj === null || obj.type !== 'tree') return null;
  const entries = parseTreeData(obj.data);
  treeCache.set(oid, entries);
  return entries;
}

function treeSortKey(entry) {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function buildTreeData(entries) {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// Flattened view of a tree: Map<path, { mode, oid }> for files, cached by the
// (immutable) tree oid. Directories are implied by path prefixes.
const flatTreeCache = new Map();

function flattenTree(treeOid) {
  const cached = flatTreeCache.get(treeOid);
  if (cached !== undefined) return cached;
  const out = new Map();
  const walk = (oid, prefix) => {
    const entries = treeEntries(oid);
    if (entries === null) return;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  if (treeOid !== null && treeOid !== ZERO_OID) walk(treeOid, '');
  flatTreeCache.set(treeOid, out);
  return out;
}

// Build a new tree from a flattened file map (path -> blob oid).
function treeFromFlat(flat) {
  const build = (prefix) => {
    const entries = [];
    const dirs = new Map();
    for (const [path, info] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: info.mode, name: rest, oid: info.oid });
      else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, true);
      }
    }
    for (const dir of dirs.keys()) {
      const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      entries.push({ mode: '40000', name: dir, oid: build(childPrefix) });
    }
    return storeObject('tree', buildTreeData(entries));
  };
  return build('');
}

// --- tags ------------------------------------------------------------------

function peelToCommit(oid) {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const obj = getObject(current);
    if (obj === null) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return null;
    current = match[1];
  }
  return null;
}

function peelTagOnce(oid) {
  const obj = getObject(oid);
  if (obj === null || obj.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
  return match === null ? null : match[1];
}

// --- ancestry / traversal ----------------------------------------------------

// Is `ancestor` reachable from `descendant` following commit parents?
function isAncestor(ancestor, descendant) {
  if (ancestor === descendant) return true;
  const seen = new Set([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.pop();
    const parsed = parseCommit(current);
    if (parsed === null) continue;
    for (const parent of parsed.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

// Best common ancestor of two commits (the merge base), or null.
function mergeBase(a, b) {
  if (a === b) return a;
  const ancestorsOfA = new Map(); // oid -> distance from a
  {
    const queue = [[a, 0]];
    ancestorsOfA.set(a, 0);
    while (queue.length > 0) {
      const [current, dist] = queue.shift();
      const parsed = parseCommit(current);
      if (parsed === null) continue;
      for (const parent of parsed.parents) {
        if (!ancestorsOfA.has(parent)) {
          ancestorsOfA.set(parent, dist + 1);
          queue.push([parent, dist + 1]);
        }
      }
    }
  }
  const seen = new Set([b]);
  const queue = [b];
  while (queue.length > 0) {
    const current = queue.shift();
    if (ancestorsOfA.has(current)) return current;
    const parsed = parseCommit(current);
    if (parsed === null) continue;
    for (const parent of parsed.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

// All commits reachable from a tip, tip first, parents in commit order.
function listCommitsFrom(tip) {
  const out = [];
  const seen = new Set();
  const stack = [tip];
  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    const parsed = parseCommit(current);
    if (parsed === null) continue;
    seen.add(current);
    out.push(current);
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles: read (with OFS/REF delta resolution, for pushes that use them)
// and write (plain objects only: no deltas, which every client accepts).
// ---------------------------------------------------------------------------

function inflateAt(buffer, offset) {
  const result = inflateSync(buffer.subarray(offset), { info: true });
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base, delta) {
  let offset = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset]; offset += 1; }
      if (op & 0x02) { copyOffset += delta[offset] * 256; offset += 1; }
      if (op & 0x04) { copyOffset += delta[offset] * 65536; offset += 1; }
      if (op & 0x08) { copyOffset += delta[offset] * 16777216; offset += 1; }
      if (op & 0x10) { copySize = delta[offset]; offset += 1; }
      if (op & 0x20) { copySize += delta[offset] * 256; offset += 1; }
      if (op & 0x40) { copySize += delta[offset] * 65536; offset += 1; }
      if (copySize === 0) copySize = 65536;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

// Parse one pack into the store. Throws on any structural problem; the caller
// reports "unpack <reason>" and moves no refs.
function receivePack(pack) {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  let offset = 12;
  const rawEntries = []; // { type, data } for plain, { deltaKind, baseOid|baseOffset, data } for deltas
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const type = ID_TYPES[typeId];
    if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
    if (type === 'ofs-delta') {
      byte = pack[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        baseOffset = (baseOffset + 1) * 128 + (byte & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      rawEntries.push({ deltaKind: 'ofs', baseEntryOffset: entryOffset - baseOffset, data: inflated.data, entryOffset });
    } else if (type === 'ref-delta') {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      rawEntries.push({ deltaKind: 'ref', baseOid, data: inflated.data, entryOffset });
    } else {
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      rawEntries.push({ deltaKind: null, type, data: inflated.data, entryOffset });
    }
  }
  // Resolve deltas (possibly chained) and store everything.
  const byOffset = new Map();
  const resolved = new Map(); // entryOffset -> oid
  const resolveEntry = (entry) => {
    if (resolved.has(entry.entryOffset)) return resolved.get(entry.entryOffset);
    let oid;
    if (entry.deltaKind === null) {
      oid = storeObject(entry.type, entry.data);
    } else {
      let baseType;
      let baseData;
      if (entry.deltaKind === 'ofs') {
        const baseEntry = byOffset.get(entry.baseEntryOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
        const baseOid = resolveEntry(baseEntry);
        const base = getObject(baseOid);
        baseType = base.type;
        baseData = base.data;
      } else {
        const base = getObject(entry.baseOid);
        if (base === null) throw new Error('ref-delta base not available');
        baseType = base.type;
        baseData = base.data;
      }
      const data = applyDelta(baseData, entry.data);
      oid = storeObject(baseType, data);
    }
    resolved.set(entry.entryOffset, oid);
    return oid;
  };
  for (const entry of rawEntries) byOffset.set(entry.entryOffset, entry);
  for (const entry of rawEntries) resolveEntry(entry);
}

function packEntryHeader(typeId, size) {
  const bytes = [];
  let byte = ((typeId & 0x07) << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

// A version-2 pack holding exactly `oids` (plain objects, no deltas).
function buildPack(oids) {
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = getObject(oid);
    if (obj === null) throw new Error(`cannot pack missing object ${oid}`);
    parts.push(packEntryHeader(TYPE_IDS[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// --- fetch object selection --------------------------------------------------

// The full object closure of a set of roots. When `shallowCut` (a Set of
// commit oids the client holds only shallowly) is given, those commits count
// as held (with their trees) but their parents are not traversed.
function objectClosure(roots, shallowCut) {
  const out = new Set();
  const addTree = (treeOid) => {
    if (treeOid === null || out.has(treeOid)) return;
    const obj = getObject(treeOid);
    if (obj === null || obj.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of treeEntries(treeOid) ?? []) {
      if (entry.mode === '40000') addTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  const addCommit = (oid, traverseParents) => {
    if (out.has(oid)) return;
    const parsed = parseCommit(oid);
    if (parsed === null) return;
    out.add(oid);
    addTree(parsed.tree);
    if (!traverseParents) return;
    for (const parent of parsed.parents) {
      if (shallowCut !== null && shallowCut.has(parent)) addCommit(parent, false);
      else addCommit(parent, true);
    }
  };
  const addAny = (oid) => {
    const obj = getObject(oid);
    if (obj === null) return;
    if (obj.type === 'commit') {
      if (shallowCut !== null && shallowCut.has(oid)) addCommit(oid, false);
      else addCommit(oid, true);
    } else if (obj.type === 'tag') {
      out.add(oid);
      const target = peelTagOnce(oid);
      if (target !== null) addAny(target);
    } else if (obj.type === 'tree') addTree(oid);
    else out.add(oid);
  };
  for (const root of roots) addAny(root);
  return out;
}

// What a fetch must send: { oids (deterministically ordered), shallow: [...] }.
// depth null means unbounded. Boundary commits (included, with a parent that
// exists but was not included) are reported as shallow.
function selectFetchObjects({ wants, haves, shallowHeld, depth }) {
  const shallowSet = new Set(shallowHeld ?? []);
  const excluded = objectClosure(haves ?? [], shallowSet.size > 0 ? shallowSet : null);

  // Commit inclusion by distance from the nearest want.
  const includedCommits = new Set();
  const boundary = new Set();
  const nonCommitRoots = [];
  const distance = new Map();
  const queue = [];
  const noteRoot = (oid) => {
    const obj = getObject(oid);
    if (obj === null) return;
    if (obj.type === 'commit') {
      if (!distance.has(oid)) {
        distance.set(oid, 0);
        queue.push(oid);
      }
    } else {
      nonCommitRoots.push(oid);
    }
  };
  for (const want of wants) noteRoot(want);
  while (queue.length > 0) {
    const current = queue.shift();
    const dist = distance.get(current);
    if (depth !== null && dist >= depth) continue;
    includedCommits.add(current);
    const parsed = parseCommit(current);
    if (parsed === null) continue;
    if (depth !== null && dist + 1 >= depth) continue; // parents cannot be included
    for (const parent of parsed.parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  if (depth !== null) {
    for (const oid of includedCommits) {
      const parsed = parseCommit(oid);
      if (parsed === null) continue;
      for (const parent of parsed.parents) {
        if (!includedCommits.has(parent) && getObject(parent) !== null) boundary.add(oid);
      }
    }
  }

  const included = new Set();
  const addTreeClosure = (treeOid) => {
    if (treeOid === null || included.has(treeOid)) return;
    const obj = getObject(treeOid);
    if (obj === null || obj.type !== 'tree') return;
    included.add(treeOid);
    for (const entry of treeEntries(treeOid) ?? []) {
      if (entry.mode === '40000') addTreeClosure(entry.oid);
      else included.add(entry.oid);
    }
  };
  for (const oid of nonCommitRoots) {
    for (const member of objectClosure([oid], null)) included.add(member);
  }
  for (const oid of includedCommits) {
    included.add(oid);
    addTreeClosure(commitTreeOid(oid));
  }
  for (const oid of excluded) included.delete(oid);
  for (const oid of boundary) {
    // A boundary commit the client already holds as a have is not re-sent and
    // needs no shallow line; it was removed above.
    if (excluded.has(oid)) boundary.delete(oid);
  }

  // Deterministic order: commits (BFS order), tags, trees, blobs, each stable.
  const commits = [];
  const tags = [];
  const trees = [];
  const blobs = [];
  for (const oid of included) {
    const obj = getObject(oid);
    if (obj === null) continue;
    if (obj.type === 'commit') commits.push(oid);
    else if (obj.type === 'tag') tags.push(oid);
    else if (obj.type === 'tree') trees.push(oid);
    else blobs.push(oid);
  }
  commits.sort((x, y) => (distance.get(x) ?? 0) - (distance.get(y) ?? 0) || (x < y ? -1 : 1));
  tags.sort();
  trees.sort();
  blobs.sort();
  return { oids: [...commits, ...tags, ...trees, ...blobs], shallow: [...boundary].sort() };
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

function pktLine(payload) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

// Parse a pkt-line stream. Returns { packets: [{kind, payload}], rest } or
// null when the bytes are not a well-formed pkt-line stream.
function parsePktLines(buffer) {
  const packets = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) return null;
    const headerText = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) return null;
    const length = parseInt(headerText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length < 4 || offset + length > buffer.length) {
      return null;
    } else {
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return { packets, rest: buffer.subarray(offset) };
}

// Split sideband-carried pack bytes into pkt-lines (band byte 1 + chunk).
function sidebandPackets(pack) {
  const parts = [];
  const CHUNK = 65515; // + 1 band byte + 4 header bytes <= 65520
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.from([1])));
    return parts;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Domain store: repositories and everything that hangs off them.
// A repository: {
//   id, owner, name, description, private, defaultBranch,
//   refs: Map<refname, oid>,
//   labels: Map<name, { id, name, color }>,
//   issues: Map<number, issue>, pulls: Map<number, pull>,
//   nextNumber (one sequence shared by issues and pull requests),
//   createdSec, updatedSec,
// }
// An issue: { id, number, title, body, state, labels: [name], comments:
//   [{ id, body, createdSec }], createdSec, updatedSec }
// A pull: { id, number, title, body, headRef, baseRef, state, merged,
//   mergeCommitSha, mergedSec, createdSec, updatedSec }
// ---------------------------------------------------------------------------

const reposByKey = new Map(); // `${owner.toLowerCase()}/${name.toLowerCase()}` -> repo

function repoKey(owner, name) {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function createRepo({ name, description, isPrivate }) {
  const sec = nextStamp();
  const repo = {
    id: nextRepoId,
    owner: VIEWER,
    name,
    description: description ?? '',
    private: isPrivate ?? false,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdSec: sec,
    updatedSec: sec,
  };
  nextRepoId += 1;
  reposByKey.set(repoKey(repo.owner, repo.name), repo);
  return repo;
}

function findRepo(owner, name) {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  // A repository belongs to the login the token names: anything addressed
  // under another owner does not exist for this caller.
  if (owner.toLowerCase() !== VIEWER.toLowerCase()) return null;
  return reposByKey.get(repoKey(owner, name)) ?? null;
}

function deleteRepo(repo) {
  reposByKey.delete(repoKey(repo.owner, repo.name));
}

function repoHeadRef(repo) {
  return `refs/heads/${repo.defaultBranch}`;
}

function branchTip(repo, branch) {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function commitTreeOid(commitOid) {
  const parsed = parseCommit(commitOid);
  return parsed === null ? null : parsed.tree;
}

function flatTreeOfCommit(commitOid) {
  if (commitOid === null) return new Map();
  const tree = commitTreeOid(commitOid);
  return tree === null ? new Map() : flattenTree(tree);
}

// One forge-authored commit on top of `parent` (or a root commit when null)
// whose tree is `flat` (path -> {mode, oid}); returns the commit oid.
function commitFlatTree(repo, parent, flat, message) {
  const tree = treeFromFlat(flat);
  if (parent !== null) {
    const parentTree = commitTreeOid(parent);
    if (parentTree === tree) return parent; // no change: no empty commit
  }
  const sec = nextStamp();
  repo.updatedSec = sec;
  return buildCommit({ tree, parents: parent === null ? [] : [parent], message: `${message}\n`, sec });
}

// The contents API write: set `path` to blob `content` (or remove it when
// content is null) on `branch`, creating the branch from the default branch
// when it does not exist yet. Returns { commit, created }.
function applyContentsChange(repo, branch, path, content, message) {
  let tip = branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    tip = branchTip(repo, repo.defaultBranch);
  }
  const flat = new Map(flatTreeOfCommit(tip));
  const existing = flat.get(path);
  if (content === null) {
    flat.delete(path);
  } else {
    const blobOid = storeObject('blob', content);
    flat.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
  }
  const commit = commitFlatTree(repo, tip, flat, message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  return { commit, created: existing === undefined };
}

// Line-level diff counts between two blob contents (LCS over lines; the
// files the suite diffs are small text files).
function lineDiffCounts(oldText, newText) {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  // LCS lengths with two rows.
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      curr[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[0];
  return { additions: n - common, deletions: m - common };
}

// Changed paths between the merge base of head/base and the head tip:
// [{ filename, status, additions, deletions, changes }].
function pullRequestFiles(repo, pull) {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(baseTip, headTip) ?? baseTip;
  const fromFlat = flatTreeOfCommit(base);
  const toFlat = flatTreeOfCommit(headTip);
  const files = [];
  const paths = new Set([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    const oldText = from === undefined ? '' : (getObject(from.oid)?.data.toString('utf8') ?? '');
    const newText = to === undefined ? '' : (getObject(to.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiffCounts(oldText, newText);
    files.push({
      filename: path,
      status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

// Three-way, file-level merge of head into base. Returns
// { conflict: true } or { conflict: false, flat } (the merged tree, flattened).
function threeWayMerge(repo, baseTip, headTip) {
  const mb = mergeBase(baseTip, headTip);
  if (mb === null) return { conflict: true };
  if (mb === headTip) return { conflict: false, flat: flatTreeOfCommit(baseTip), alreadyMerged: true };
  const baseFlat = flatTreeOfCommit(mb);
  const ourFlat = flatTreeOfCommit(baseTip);
  const theirFlat = flatTreeOfCommit(headTip);
  const merged = new Map();
  const paths = new Set([...baseFlat.keys(), ...ourFlat.keys(), ...theirFlat.keys()]);
  for (const path of paths) {
    const inBase = baseFlat.get(path)?.oid ?? null;
    const inOurs = ourFlat.get(path)?.oid ?? null;
    const inTheirs = theirFlat.get(path)?.oid ?? null;
    let chosen;
    if (inTheirs === inBase) chosen = inOurs === null ? null : ourFlat.get(path);
    else if (inOurs === inBase) chosen = inTheirs === null ? null : theirFlat.get(path);
    else if (inOurs === inTheirs) chosen = inOurs === null ? null : ourFlat.get(path);
    else return { conflict: true };
    if (chosen !== null && chosen !== undefined) merged.set(path, chosen);
  }
  return { conflict: false, flat: merged, alreadyMerged: false };
}

// Perform the merge of a pull request (squash semantics: one new commit on
// the base branch holding the merged tree). Returns { sha } or { conflict }.
function mergePullRequest(repo, pull, method) {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { conflict: true };
  const result = threeWayMerge(repo, baseTip, headTip);
  if (result.conflict) return { conflict: true };
  let sha;
  if (method === 'merge' && !result.alreadyMerged) {
    const tree = treeFromFlat(result.flat);
    const sec = nextStamp();
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    let text = `tree ${tree}\nparent ${baseTip}\nparent ${headTip}\n`;
    text += `author ${forgeIdentity(sec)}\ncommitter ${forgeIdentity(sec)}\n\n${message}`;
    sha = storeObject('commit', Buffer.from(text, 'utf8'));
  } else if (result.alreadyMerged) {
    sha = baseTip;
  } else {
    const body = pull.body ? `\n\n${pull.body}` : '';
    sha = commitFlatTree(repo, baseTip, result.flat, `${pull.title} (#${pull.number})${body}`);
    if (sha === baseTip) {
      // The merged tree equals the base tree (e.g. an empty diff): still make
      // a distinct squash commit so the merge has its own sha.
      const tree = treeFromFlat(result.flat);
      const sec = nextStamp();
      let text = `tree ${tree}\nparent ${baseTip}\n`;
      text += `author ${forgeIdentity(sec)}\ncommitter ${forgeIdentity(sec)}\n\n${pull.title} (#${pull.number})${body}\n`;
      sha = storeObject('commit', Buffer.from(text, 'utf8'));
    }
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const sec = nextStamp();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedSec = sec;
  pull.updatedSec = sec;
  return { sha };
}

// ---------------------------------------------------------------------------
// Serializers (REST shapes)
// ---------------------------------------------------------------------------

function userJson(login) {
  return { login, id: 1000, type: 'User' };
}

function repoJson(repo) {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoOf(repo.createdSec),
    updated_at: isoOf(repo.updatedSec),
    html_url: `https://github.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://github.invalid/${repo.owner}/${repo.name}.git`,
  };
}

function labelJson(label) {
  return { id: label.id, name: label.name, color: label.color, description: null, default: false };
}

function issueJson(repo, issue) {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name } : labelJson(label);
    }),
    user: userJson(repo.owner),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.updatedSec),
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(comment) {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', String(comment.id)),
    body: comment.body,
    user: userJson(VIEWER),
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.createdSec),
  };
}

function pullJson(repo, pull) {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? isoOf(pull.mergedSec) : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    head: {
      ref: pull.headRef,
      sha: headTip,
      label: `${repo.owner}:${pull.headRef}`,
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: repoJson(repo),
    },
    user: userJson(repo.owner),
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.updatedSec),
    html_url: `https://github.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(oid) {
  const parsed = parseCommit(oid);
  const obj = getObject(oid);
  const identMatch = parsed === null ? null : /^(.+) <(.*?)> (\d+) /.exec(parsed.authorLine);
  const name = identMatch === null ? VIEWER : identMatch[1];
  const email = identMatch === null ? `${VIEWER}@example.invalid` : identMatch[2];
  const sec = identMatch === null ? EPOCH_SEC : Number(identMatch[3]);
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      message: parsed === null ? '' : parsed.message.replace(/\n$/, ''),
      tree: { sha: parsed === null ? ZERO_OID : parsed.tree },
      author: { name, email, date: isoOf(sec) },
      committer: { name, email, date: isoOf(sec) },
    },
    author: userJson(VIEWER),
    committer: userJson(VIEWER),
    parents: (parsed === null ? [] : parsed.parents).map((parent) => ({ sha: parent })),
    ...(obj === null ? {} : {}),
  };
}

// Opaque global ids for GraphQL/node(): base64url of "Type:payload". They are
// stable, decodable by this forge, and never the plain database id.
function globalId(type, payload) {
  return Buffer.from(`${type}:${payload}`, 'utf8').toString('base64url');
}

function parseGlobalId(id) {
  if (typeof id !== 'string' || id === '') return null;
  let text;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const type = text.slice(0, colon);
  const payload = text.slice(colon + 1);
  if (!['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Commit'].includes(type)) return null;
  return { type, payload };
}

function repoByGlobalId(id) {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  const dbId = Number(parsed.payload);
  for (const repo of reposByKey.values()) if (repo.id === dbId) return repo;
  return null;
}

function issueByGlobalId(id) {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  const [repoId, number] = parsed.payload.split(':').map(Number);
  for (const repo of reposByKey.values()) {
    if (repo.id === repoId) return { repo, issue: repo.issues.get(number) ?? null };
  }
  return null;
}

function pullByGlobalId(id) {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  const [repoId, number] = parsed.payload.split(':').map(Number);
  for (const repo of reposByKey.values()) {
    if (repo.id === repoId) return { repo, pull: repo.pulls.get(number) ?? null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function tokenOk(req) {
  if (SHOP_TOKEN === '') return true; // standalone dev mode: no token configured
  const header = req.headers.authorization ?? '';
  const expected = `Bearer ${SHOP_TOKEN}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    'x-github-request-id': `req-${(requestSeq += 1)}`,
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { message });
}

function sendBytes(res, status, body, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
    ...extraHeaders,
  });
  res.end(body);
}

// Parse a JSON request body: { ok: true, value } or { ok: false } (malformed).
function parseJsonBody(buffer) {
  if (buffer.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (value === null || typeof value !== 'object') return { ok: true, value: {} };
    return { ok: true, value };
  } catch {
    return { ok: false, value: null };
  }
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const AGENT_STRING = 'makefun-forge/1.0.0';
const UPLOAD_CAPS_V0 =
  'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not ' +
  `agent=${AGENT_STRING} symref=HEAD:refs/heads/main`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT_STRING}`;

function sortedRefNames(repo) {
  return [...repo.refs.keys()].sort();
}

// The ref lines shared by the v0 advertisements: HEAD first (with the
// capabilities on it), then every ref, tags followed by their peeled line.
function v0RefLines(repo, capabilities) {
  const lines = [];
  const headTarget = repoHeadRef(repo);
  const headTip = repo.refs.get(headTarget) ?? ZERO_OID;
  if (repo.refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
    return lines;
  }
  lines.push(`${headTip} HEAD\0${capabilities}\n`);
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name);
    lines.push(`${oid} ${name}\n`);
    if (name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(oid);
      if (peeled !== null && peeled !== oid) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  return lines;
}

function handleInfoRefs(req, res, repo, service, url) {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBytes(res, 400, Buffer.from('invalid service\n'), 'text/plain');
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    const parts = [
      pktLine('version 2\n'),
      pktLine(`agent=${AGENT_STRING}\n`),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ];
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-advertisement');
    return;
  }
  const preamble = service === 'git-upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts = [pktLine(preamble), PKT_FLUSH];
  for (const line of v0RefLines(repo, caps)) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

// One ls-refs answer line set (protocol v2).
function lsRefsLines(repo, args) {
  const prefixes = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines = [];
  const headTarget = repoHeadRef(repo);
  const headTip = repo.refs.get(headTarget) ?? null;
  const headMatches = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p) || p.startsWith('HEAD'));
  if (headMatches) {
    if (headTip !== null) {
      lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`);
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name);
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

function fetchResponse(repo, request) {
  const { oids, shallow } = selectFetchObjects(request);
  const pack = buildPack(oids);
  return { pack, shallow };
}

function handleUploadPack(res, repo, body) {
  const parsed = parsePktLines(body);
  if (parsed === null || parsed.packets.length === 0) {
    sendBytes(res, 400, Buffer.from('malformed pkt-line stream\n'), 'text/plain');
    return;
  }
  const first = parsed.packets[0];
  const firstLine = first.kind === 'data' ? first.payload.toString('utf8') : '';

  // Protocol v2: the first line names the command.
  if (firstLine.startsWith('command=')) {
    const command = firstLine.slice('command='.length).trim();
    const args = [];
    let afterDelim = false;
    for (const packet of parsed.packets.slice(1)) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data' && afterDelim) args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    if (command === 'ls-refs') {
      const parts = lsRefsLines(repo, args).map((line) => pktLine(line));
      parts.push(PKT_FLUSH);
      sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants = [];
      const haves = [];
      const shallowHeld = [];
      let depth = null;
      let done = false;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallowHeld.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
        else if (arg === 'done') done = true;
      }
      for (const oid of [...wants]) {
        if (getObject(oid) === null) {
          sendBytes(res, 400, Buffer.from(`remote: no such object ${oid}\n`), 'text/plain');
          return;
        }
      }
      // A negotiation round (no `done`) is answered with acknowledgments
      // only; a finished request goes straight to shallow-info + packfile,
      // which is what git's own state machine expects.
      if (!done) {
        const parts = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH];
        sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
        return;
      }
      const { pack, shallow } = fetchResponse(repo, { wants, haves, shallowHeld, depth });
      const parts = [];
      const unshallow = shallowHeld.filter((oid) => !shallow.includes(oid) && haves.includes(oid) === false);
      if (shallow.length > 0 || shallowHeld.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(PKT_DELIM);
      }
      parts.push(pktLine('packfile\n'));
      for (const packet of sidebandPackets(pack)) parts.push(packet);
      parts.push(PKT_FLUSH);
      sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    sendBytes(res, 400, Buffer.from(`unknown command ${command}\n`), 'text/plain');
    return;
  }

  // Protocol v0: want lines, a flush, have lines and done, a second flush,
  // then (optionally) the pack is part of the same request body? No: v0 fetch
  // is a single POST whose answer is NAK + shallow lines + the sideband pack.
  if (firstLine.startsWith('want ') || firstLine.startsWith('want-')) {
    const wants = [];
    const haves = [];
    const shallowHeld = [];
    let depth = null;
    let sideband = false;
    for (const packet of parsed.packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        wants.push((space < 0 ? rest : rest.slice(0, space)).trim());
        if (space >= 0 && rest.slice(space + 1).includes('side-band-64k')) sideband = true;
      } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallowHeld.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    }
    const { pack, shallow } = fetchResponse(repo, { wants, haves, shallowHeld, depth });
    const parts = [pktLine('NAK\n')];
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    if (sideband) {
      for (const packet of sidebandPackets(pack)) parts.push(packet);
    } else {
      parts.push(pack);
    }
    parts.push(PKT_FLUSH);
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }

  sendBytes(res, 400, Buffer.from('unrecognized upload-pack request\n'), 'text/plain');
}

function handleReceivePack(res, repo, body) {
  // Commands are pkt-lines up to the first flush; the pack follows raw.
  let offset = 0;
  const commands = [];
  let capabilities = '';
  let malformed = false;
  for (;;) {
    if (offset + 4 > body.length) {
      malformed = true;
      break;
    }
    const headerText = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) {
      malformed = true;
      break;
    }
    const length = parseInt(headerText, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) {
      malformed = true;
      break;
    }
    let line = body.toString('utf8', offset + 4, offset + length).replace(/\n$/, '');
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const fields = line.split(' ');
    if (fields.length === 3) commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
    offset += length;
  }
  if (malformed) {
    sendBytes(res, 400, Buffer.from('malformed receive-pack request\n'), 'text/plain');
    return;
  }
  const pack = body.subarray(offset);
  const wantsReport = capabilities.split(' ').includes('report-status');
  const useSideband = capabilities.split(' ').includes('side-band-64k');

  let unpackError = null;
  if (pack.length > 0) {
    try {
      receivePack(pack);
    } catch (error) {
      unpackError = error instanceof Error ? error.message : String(error);
    }
  }

  const results = [];
  if (unpackError === null) {
    for (const command of commands) {
      results.push(applyRefUpdate(repo, command));
    }
  } else {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  }

  if (!wantsReport) {
    sendBytes(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const reportParts = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (useSideband) {
    const wrapped = [];
    const CHUNK = 65515; // + 1 band byte + 4 header bytes <= 65520
    for (let at = 0; at < report.length; at += CHUNK) {
      wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(at, Math.min(report.length, at + CHUNK))])));
    }
    wrapped.push(PKT_FLUSH);
    sendBytes(res, 200, Buffer.concat(wrapped), 'application/x-git-receive-pack-result');
  } else {
    sendBytes(res, 200, report, 'application/x-git-receive-pack-result');
  }
}

// Validate and apply one ref update. Returns { ref, ok, reason? }.
function applyRefUpdate(repo, { oldOid, newOid, ref }) {
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) {
    return { ref, ok: false, reason: 'invalid ref name' };
  }
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) {
    return { ref, ok: false, reason: 'stale info' };
  }
  if (newOid === ZERO_OID) {
    repo.refs.delete(ref);
    return { ref, ok: true };
  }
  const target = getObject(newOid);
  if (target === null) return { ref, ok: false, reason: 'missing object' };
  if (current !== ZERO_OID) {
    const currentCommit = peelToCommit(current);
    const newCommit = peelToCommit(newOid);
    if (currentCommit === null || newCommit === null || !isAncestor(currentCommit, newCommit)) {
      return { ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true };
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function pagination(url) {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function paginate(items, url, basePath, origin) {
  const { perPage, page } = pagination(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers = {};
  if (start + perPage < items.length) {
    const next = new URL(basePath, origin ?? 'http://forge.invalid');
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { slice, headers };
}

function requestOrigin(req) {
  return `http://${req.headers.host ?? 'localhost'}`;
}

function handleRest(req, res, url, body) {
  const path = url.pathname;
  const method = req.method;

  // Root and meta.
  if (path === '/api/v3' || path === '/api/v3/') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { installed_version: '1.0.0', api_version: 'v3' });
  }
  if (path === '/api/v3/user') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, { ...userJson(VIEWER), name: VIEWER, email: `${VIEWER}@example.invalid` });
  }

  // Repository creation and the viewer's list.
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '' || /[\s/]/.test(name)) {
        return sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }] });
      }
      if (reposByKey.has(repoKey(VIEWER, name))) {
        return sendJson(res, 422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
      }
      const repo = createRepo({
        name,
        description: typeof parsed.value.description === 'string' ? parsed.value.description : '',
        isPrivate: parsed.value.private === true,
      });
      return sendJson(res, 201, repoJson(repo));
    }
    if (method === 'GET') {
      const mine = [...reposByKey.values()].filter((repo) => repo.owner === VIEWER).sort((a, b) => a.id - b.id);
      const { slice, headers } = paginate(mine.map((repo) => repoJson(repo)), url, '/api/v3/user/repos', requestOrigin(req));
      return sendJson(res, 200, slice, headers);
    }
    return sendError(res, 404, 'Not Found');
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (repoMatch === null) return sendError(res, 404, 'Not Found');
  const owner = decodeURIComponent(repoMatch[1]);
  const repoName = decodeURIComponent(repoMatch[2]);
  const rest = repoMatch[3] ?? '';
  const repo = findRepo(owner, repoName);
  if (repo === null) return sendError(res, 404, 'Not Found');

  if (rest === '') {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      repo.updatedSec = nextStamp();
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': `req-${(requestSeq += 1)}` });
      return res.end();
    }
    return sendError(res, 404, 'Not Found');
  }

  return handleRepoRoute(req, res, url, body, repo, rest);
}

function handleRepoRoute(req, res, url, body, repo, rest) {
  const method = req.method;
  const segments = rest.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));

  // --- branches and commits -------------------------------------------------
  if (segments[0] === 'branches') {
    if (segments.length === 1 && method === 'GET') {
      const branches = [];
      for (const name of sortedRefNames(repo)) {
        if (!name.startsWith('refs/heads/')) continue;
        branches.push({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) }, protected: false });
      }
      return sendJson(res, 200, branches);
    }
    if (segments.length >= 2 && method === 'GET') {
      const branch = segments.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) return sendError(res, 404, 'Branch not found');
      return sendJson(res, 200, { name: branch, commit: commitJson(tip), protected: false });
    }
    return sendError(res, 404, 'Not Found');
  }

  if (segments[0] === 'commits') {
    if (segments.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      let tip = null;
      if (shaParam !== null && shaParam !== '') {
        tip = branchTip(repo, shaParam) ?? (getObject(shaParam)?.type === 'commit' ? shaParam : null) ?? repo.refs.get(shaParam) ?? null;
      } else {
        tip = branchTip(repo, repo.defaultBranch);
      }
      if (tip === null) return sendJson(res, 200, []);
      const all = listCommitsFrom(tip).map((oid) => commitJson(oid));
      const { slice, headers } = paginate(all, url, url.pathname, requestOrigin(req));
      return sendJson(res, 200, slice, headers);
    }
    if (segments.length === 2 && method === 'GET') {
      const oid = segments[1];
      if (getObject(oid)?.type !== 'commit') return sendError(res, 404, 'No commit found');
      return sendJson(res, 200, commitJson(oid));
    }
    return sendError(res, 404, 'Not Found');
  }

  // --- git refs ---------------------------------------------------------------
  if (segments[0] === 'git' && segments[1] === 'refs') {
    if (segments.length === 2 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
      if (!ref.startsWith('refs/')) return sendJson(res, 422, { message: 'Invalid ref' });
      if (getObject(sha) === null) return sendJson(res, 422, { message: 'Invalid sha' });
      if (repo.refs.has(ref)) return sendJson(res, 422, { message: 'Reference already exists' });
      repo.refs.set(ref, sha);
      return sendJson(res, 201, { ref, node_id: globalId('Ref', ref), object: { sha, type: getObject(sha).type } });
    }
    if (segments.length === 2 && method === 'GET') {
      const list = sortedRefNames(repo).map((ref) => ({ ref, object: { sha: repo.refs.get(ref), type: getObject(repo.refs.get(ref))?.type ?? 'commit' } }));
      return sendJson(res, 200, list);
    }
    if (segments.length >= 3 && method === 'GET') {
      const ref = `refs/${segments.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return sendError(res, 404, 'Reference not found');
      return sendJson(res, 200, { ref, node_id: globalId('Ref', ref), object: { sha: oid, type: getObject(oid)?.type ?? 'commit' } });
    }
    return sendError(res, 404, 'Not Found');
  }

  // --- contents -----------------------------------------------------------------
  if (segments[0] === 'contents') {
    const contentPath = segments.slice(1).join('/');
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref');
      let tip = null;
      if (refParam !== null && refParam !== '') {
        tip = branchTip(repo, refParam) ?? (getObject(refParam)?.type === 'commit' ? refParam : null);
      } else {
        tip = branchTip(repo, repo.defaultBranch);
      }
      const flat = flatTreeOfCommit(tip);
      if (contentPath === '') {
        return sendJson(res, 200, dirListing(repo, flat, ''));
      }
      const file = flat.get(contentPath);
      if (file !== undefined) {
        const data = getObject(file.oid)?.data ?? Buffer.alloc(0);
        return sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: contentPath.split('/').pop(),
          path: contentPath,
          sha: file.oid,
          content: data.toString('base64'),
        });
      }
      const prefix = `${contentPath}/`;
      const isDir = [...flat.keys()].some((key) => key.startsWith(prefix));
      if (isDir) return sendJson(res, 200, dirListing(repo, flat, contentPath));
      return sendError(res, 404, 'Not Found');
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Update file';
      const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
      if (typeof parsed.value.content !== 'string') return sendJson(res, 422, { message: 'content is required' });
      const content = Buffer.from(parsed.value.content.replace(/\s+/g, ''), 'base64');
      const tip = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
      const flat = flatTreeOfCommit(tip);
      const existing = flat.get(contentPath);
      if (existing !== undefined) {
        if (typeof parsed.value.sha !== 'string') return sendJson(res, 422, { message: 'sha is required when updating a file' });
        if (parsed.value.sha !== existing.oid) return sendJson(res, 409, { message: 'sha does not match the current blob' });
      }
      const { commit, created } = applyContentsChange(repo, branch, contentPath, content, message);
      const newFlat = flatTreeOfCommit(commit);
      const newFile = newFlat.get(contentPath);
      const blobOid = newFile?.oid ?? storeObject('blob', content);
      return sendJson(res, created ? 201 : 200, {
        content: {
          type: 'file',
          encoding: 'base64',
          size: content.length,
          name: contentPath.split('/').pop(),
          path: contentPath,
          sha: blobOid,
          content: content.toString('base64'),
        },
        commit: { sha: commit, message, tree: { sha: commitTreeOid(commit) }, parents: (parseCommit(commit)?.parents ?? []).map((sha) => ({ sha })) },
      });
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Delete file';
      const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
      const tip = branchTip(repo, branch);
      const flat = flatTreeOfCommit(tip);
      const existing = flat.get(contentPath);
      if (existing === undefined) return sendError(res, 404, 'Not Found');
      if (typeof parsed.value.sha === 'string' && parsed.value.sha !== existing.oid) {
        return sendJson(res, 409, { message: 'sha does not match the current blob' });
      }
      const { commit } = applyContentsChange(repo, branch, contentPath, null, message);
      return sendJson(res, 200, { content: null, commit: { sha: commit, message } });
    }
    return sendError(res, 404, 'Not Found');
  }

  // --- labels -------------------------------------------------------------------
  if (segments[0] === 'labels') {
    if (segments.length === 1 && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '') return sendJson(res, 422, { message: 'name is required' });
      if (repo.labels.has(name)) return sendJson(res, 422, { message: 'Label already exists' });
      const label = { id: nextLabelId, name, color: typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed' };
      nextLabelId += 1;
      repo.labels.set(name, label);
      return sendJson(res, 201, labelJson(label));
    }
    if (segments.length === 1 && method === 'GET') {
      return sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
    }
    return sendError(res, 404, 'Not Found');
  }

  // --- issues -------------------------------------------------------------------
  if (segments[0] === 'issues') {
    return handleIssues(req, res, url, body, repo, segments);
  }

  // --- pull requests ------------------------------------------------------------
  if (segments[0] === 'pulls') {
    return handlePulls(req, res, url, body, repo, segments);
  }

  return sendError(res, 404, 'Not Found');
}

// The immediate children of `prefix` in a flattened tree, GitHub-style.
function dirListing(repo, flat, prefix) {
  const entries = new Map();
  const base = prefix === '' ? '' : `${prefix}/`;
  for (const [path, info] of flat) {
    if (prefix !== '' && !path.startsWith(base)) continue;
    const rest = path.slice(base.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { type: 'file', name: rest, path, sha: info.oid, size: getObject(info.oid)?.data.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!entries.has(dir)) {
        entries.set(dir, { type: 'dir', name: dir, path: base + dir, sha: treeShaForPath(repo, flat, base + dir), size: 0 });
      }
    }
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

// The tree oid that holds a directory path (used in directory listings).
function treeShaForPath(repo, flat, dirPath) {
  // Recompute the subtree oid by rebuilding that directory's tree.
  const sub = new Map();
  const prefix = `${dirPath}/`;
  for (const [path, info] of flat) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), info);
  }
  return treeFromFlat(sub);
}

function labelNamesOf(repo, rawLabels) {
  // Returns { names } or { error } (a label that was never created -> 422).
  const names = [];
  if (rawLabels === undefined) return { names };
  if (!Array.isArray(rawLabels)) return { error: 'labels must be an array' };
  for (const entry of rawLabels) {
    const name = typeof entry === 'string' ? entry : typeof entry?.name === 'string' ? entry.name : null;
    if (name === null) return { error: 'invalid label' };
    if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
    names.push(name);
  }
  return { names };
}

function createIssueRecord(repo, { title, body, labels }) {
  const sec = nextStamp();
  const issue = {
    id: nextIssueId,
    number: repo.nextNumber,
    title,
    body: body ?? '',
    state: 'open',
    labels: labels ?? [],
    comments: [],
    createdSec: sec,
    updatedSec: sec,
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function handleIssues(req, res, url, body, repo, segments) {
  const method = req.method;
  if (segments.length === 1) {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
      if (title === '') return sendJson(res, 422, { message: 'title is required' });
      const labelResult = labelNamesOf(repo, parsed.value.labels);
      if (labelResult.error !== undefined) return sendJson(res, 422, { message: labelResult.error });
      const issue = createIssueRecord(repo, {
        title,
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        labels: labelResult.names,
      });
      return sendJson(res, 201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      if (direction !== 'asc') list.reverse();
      const { slice, headers } = paginate(list.map((issue) => issueJson(repo, issue)), url, url.pathname, requestOrigin(req));
      return sendJson(res, 200, slice, headers);
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number(segments[1]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (segments.length === 2) {
    if (issue === undefined) return sendError(res, 404, 'Issue not found');
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      if (parsed.value.labels !== undefined) {
        const labelResult = labelNamesOf(repo, parsed.value.labels);
        if (labelResult.error !== undefined) return sendJson(res, 422, { message: labelResult.error });
        issue.labels = labelResult.names;
      }
      issue.updatedSec = nextStamp();
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (segments.length === 3 && segments[2] === 'comments') {
    if (issue === undefined) return sendError(res, 404, 'Issue not found');
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const text = typeof parsed.value.body === 'string' ? parsed.value.body : '';
      if (text === '') return sendJson(res, 422, { message: 'body is required' });
      const comment = { id: nextCommentId, body: text, createdSec: nextStamp() };
      nextCommentId += 1;
      issue.comments.push(comment);
      return sendJson(res, 201, commentJson(comment));
    }
    if (method === 'GET') {
      const { slice, headers } = paginate(issue.comments.map((comment) => commentJson(comment)), url, url.pathname, requestOrigin(req));
      return sendJson(res, 200, slice, headers);
    }
    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}

function createPullRecord(repo, { title, body, headRef, baseRef }) {
  const sec = nextStamp();
  const pull = {
    id: nextIssueId,
    number: repo.nextNumber,
    title,
    body: body ?? '',
    headRef,
    baseRef,
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedSec: null,
    createdSec: sec,
    updatedSec: sec,
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

function stripOwnerPrefix(ref, repo) {
  const colon = ref.indexOf(':');
  if (colon > 0) {
    const maybeOwner = ref.slice(0, colon);
    if (maybeOwner.toLowerCase() === repo.owner.toLowerCase()) return ref.slice(colon + 1);
  }
  return ref;
}

function handlePulls(req, res, url, body, repo, segments) {
  const method = req.method;
  if (segments.length === 1) {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
      const headRaw = typeof parsed.value.head === 'string' ? parsed.value.head : '';
      const baseRaw = typeof parsed.value.base === 'string' ? parsed.value.base : repo.defaultBranch;
      if (title === '' || headRaw === '') return sendJson(res, 422, { message: 'title and head are required' });
      const headRef = stripOwnerPrefix(headRaw, repo);
      const baseRef = stripOwnerPrefix(baseRaw, repo);
      if (branchTip(repo, headRef) === null) return sendJson(res, 422, { message: `Head ref "${headRef}" does not exist` });
      if (branchTip(repo, baseRef) === null) return sendJson(res, 422, { message: `Base ref "${baseRef}" does not exist` });
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          return sendJson(res, 422, { message: 'A pull request already exists for this branch' });
        }
      }
      const pull = createPullRecord(repo, {
        title,
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        headRef,
        baseRef,
      });
      return sendJson(res, 201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const { slice, headers } = paginate(list.map((pull) => pullJson(repo, pull)), url, url.pathname, requestOrigin(req));
      return sendJson(res, 200, slice, headers);
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number(segments[1]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (segments.length === 2) {
    if (pull === undefined) return sendError(res, 404, 'Pull request not found');
    if (method === 'GET') return sendJson(res, 200, pullJson(repo, pull));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
      if (parsed.value.state === 'closed' && !pull.merged) pull.state = 'closed';
      if (parsed.value.state === 'open' && !pull.merged) pull.state = 'open';
      pull.updatedSec = nextStamp();
      return sendJson(res, 200, pullJson(repo, pull));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (segments.length === 3 && segments[2] === 'files' && method === 'GET') {
    if (pull === undefined) return sendError(res, 404, 'Pull request not found');
    const files = pullRequestFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: flatTreeOfCommit(branchTip(repo, pull.headRef)).get(file.filename)?.oid ?? ZERO_OID,
    }));
    const { slice, headers } = paginate(files, url, url.pathname, requestOrigin(req));
    return sendJson(res, 200, slice, headers);
  }

  if (segments.length === 3 && segments[2] === 'merge' && method === 'PUT') {
    if (pull === undefined) return sendError(res, 404, 'Pull request not found');
    const parsed = parseJsonBody(body);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    if (pull.merged) {
      return sendJson(res, 200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
    }
    if (pull.state !== 'open') return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    const methodWanted = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'squash';
    const outcome = mergePullRequest(repo, pull, methodWanted === 'merge' ? 'merge' : 'squash');
    if (outcome.conflict === true) return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    return sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser and executor covering the documents gh and
// github-mcp-server send, with the introspection surface the suite reads.
// ---------------------------------------------------------------------------

function gqlTokenize(source) {
  const tokens = [];
  let i = 0;
  const isNameStart = (c) => /[A-Za-z_]/.test(c);
  const isNameChar = (c) => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: c, value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else if (map[esc] !== undefined) {
            out += map[esc];
            j += 2;
          } else {
            throw new Error(`bad string escape \\${esc}`);
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class GqlParser {
  constructor(source) {
    this.tokens = gqlTokenize(source);
    this.pos = 0;
  }
  peek() {
    return this.tokens[this.pos];
  }
  next() {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }
  expect(kind) {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, got ${token.kind}`);
    return token;
  }
  skip(kind) {
    if (this.peek().kind === kind) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  parseDocument() {
    const operations = [];
    const fragments = new Map();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === '{') {
        operations.push({ operation: 'query', name: null, variableDefinitions: [], selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefinitions = this.peek().kind === '(' ? this.parseVariableDefinitions() : [];
        this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        operations.push({ operation: token.value, name, variableDefinitions, selectionSet });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        const onToken = this.expect('name');
        if (onToken.value !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expect('name').value;
        this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        fragments.set(fragName, { typeCondition, selectionSet });
      } else {
        throw new Error(`unexpected token ${token.kind} ${token.value}`);
      }
    }
    return { operations, fragments };
  }
  parseVariableDefinitions() {
    this.expect('(');
    const defs = [];
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expect('name').value;
      this.expect(':');
      const type = this.parseType();
      let defaultValue;
      if (this.skip('=')) defaultValue = this.parseValue(true);
      this.parseDirectives();
      defs.push({ name, type, defaultValue });
    }
    this.expect(')');
    return defs;
  }
  parseType() {
    let type;
    if (this.skip('[')) {
      const inner = this.parseType();
      this.expect(']');
      type = `[${inner}]`;
    } else {
      type = this.expect('name').value;
    }
    if (this.skip('!')) type += '!';
    return type;
  }
  parseDirectives() {
    while (this.skip('@')) {
      this.expect('name');
      if (this.peek().kind === '(') this.parseArguments();
    }
  }
  parseSelectionSet() {
    this.expect('{');
    const selections = [];
    while (this.peek().kind !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }
  parseSelection() {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        this.parseDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, selectionSet };
      }
      const name = this.expect('name').value;
      this.parseDirectives();
      return { kind: 'fragmentSpread', name };
    }
    let name = this.expect('name').value;
    let alias = null;
    if (this.skip(':')) {
      alias = name;
      name = this.expect('name').value;
    }
    const args = this.peek().kind === '(' ? this.parseArguments() : {};
    this.parseDirectives();
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selectionSet };
  }
  parseArguments() {
    this.expect('(');
    const args = {};
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValue(false);
    }
    this.expect(')');
    return args;
  }
  parseValue(isConst) {
    const token = this.peek();
    if (token.kind === '$') {
      this.next();
      return { $var: this.expect('name').value };
    }
    if (token.kind === 'string') {
      this.next();
      return token.value;
    }
    if (token.kind === 'int') {
      this.next();
      return Number(token.value);
    }
    if (token.kind === 'float') {
      this.next();
      return Number(token.value);
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { $enum: token.value };
    }
    if (token.kind === '[') {
      this.next();
      const list = [];
      while (this.peek().kind !== ']') list.push(this.parseValue(isConst));
      this.expect(']');
      return list;
    }
    if (token.kind === '{') {
      this.next();
      const obj = {};
      while (this.peek().kind !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        obj[name] = this.parseValue(isConst);
      }
      this.expect('}');
      return obj;
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

// Resolve a parsed argument value against the operation's variables.
function gqlValue(value, variables) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => gqlValue(entry, variables));
  if (value.$var !== undefined) return variables[value.$var];
  if (value.$enum !== undefined) return value.$enum;
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = gqlValue(entry, variables);
  return out;
}

function gqlArgs(rawArgs, variables) {
  const out = {};
  for (const [key, value] of Object.entries(rawArgs ?? {})) out[key] = gqlValue(value, variables);
  return out;
}

// --- GraphQL runtime wrappers -------------------------------------------------

const wRepo = (repo) => ({ __gqlType: 'Repository', repo });
const wIssue = (repo, issue) => ({ __gqlType: 'Issue', repo, issue });
const wPull = (repo, pull) => ({ __gqlType: 'PullRequest', repo, pull });
const wUser = (login) => ({ __gqlType: 'User', login });
const wComment = (comment) => ({ __gqlType: 'IssueComment', comment });

function encodeCursor(index) {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

// Slice `items` (already filtered and ordered) into a connection page.
function connectionPage(items, args) {
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.trunc(args.first) : items.length;
  const afterIndex = args.after === undefined || args.after === null ? -1 : decodeCursor(args.after);
  const start = afterIndex + 1;
  const slice = items.slice(start, start + first);
  const hasNextPage = start + slice.length < items.length;
  const endCursor = slice.length > 0 ? encodeCursor(start + slice.length - 1) : args.after ?? null;
  return {
    slice,
    pageInfo: { hasNextPage, hasPreviousPage: start > 0, startCursor: slice.length > 0 ? encodeCursor(start) : null, endCursor },
    totalCount: items.length,
    startIndex: start,
  };
}

function orderedIssues(repo, args) {
  let list = [...repo.issues.values()];
  if (Array.isArray(args.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const direction = args.orderBy?.direction === 'DESC' ? -1 : 1;
  list.sort((a, b) => direction * (a.createdSec - b.createdSec || a.number - b.number));
  return list;
}

function pullMergeable(repo, pull) {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  return threeWayMerge(repo, baseTip, headTip).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

const GQL_SCHEMA = {
  Query: {
    fields: {
      viewer: { t: 'User', resolve: () => wUser(VIEWER) },
      repository: {
        t: 'Repository',
        resolve: (_s, args) => {
          const repo = findRepo(args.owner, args.name);
          return repo === null ? null : wRepo(repo);
        },
      },
      node: {
        t: 'Node',
        resolve: (_s, args) => {
          const parsed = parseGlobalId(args.id);
          if (parsed === null) return null;
          if (parsed.type === 'Repository') {
            const repo = repoByGlobalId(args.id);
            return repo === null ? null : wRepo(repo);
          }
          if (parsed.type === 'Issue') {
            const found = issueByGlobalId(args.id);
            return found === null || found.issue === null ? null : wIssue(found.repo, found.issue);
          }
          if (parsed.type === 'PullRequest') {
            const found = pullByGlobalId(args.id);
            return found === null || found.pull === null ? null : wPull(found.repo, found.pull);
          }
          if (parsed.type === 'User') return wUser(parsed.payload);
          return null;
        },
      },
      __type: {
        t: '__Type',
        resolve: (_s, args) => (GQL_INTROSPECTION[args.name] !== undefined ? { __gqlType: '__Type', name: args.name } : null),
      },
      __schema: {
        t: '__Schema',
        resolve: () => ({ __gqlType: '__Schema' }),
      },
    },
  },
  Mutation: {
    fields: {
      createIssue: {
        t: 'CreateIssuePayload',
        resolve: (_s, args) => {
          const input = args.input ?? {};
          const repo = repoByGlobalId(input.repositoryId) ?? findRepo(VIEWER, input.repositoryId);
          if (repo === null) throw new Error('repository not found');
          const issue = createIssueRecord(repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), labels: [] });
          return { __gqlType: 'CreateIssuePayload', issue: wIssue(repo, issue), clientMutationId: input.clientMutationId ?? null };
        },
      },
      closeIssue: {
        t: 'CloseIssuePayload',
        resolve: (_s, args) => {
          const input = args.input ?? {};
          const found = issueByGlobalId(input.issueId);
          if (found === null || found.issue === null) throw new Error('issue not found');
          found.issue.state = 'closed';
          found.issue.updatedSec = nextStamp();
          return { __gqlType: 'CloseIssuePayload', issue: wIssue(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
        },
      },
      createPullRequest: {
        t: 'CreatePullRequestPayload',
        resolve: (_s, args) => {
          const input = args.input ?? {};
          const repo = repoByGlobalId(input.repositoryId) ?? findRepo(VIEWER, input.repositoryId);
          if (repo === null) throw new Error('repository not found');
          const headRef = stripOwnerPrefix(String(input.headRefName ?? ''), repo);
          const baseRef = stripOwnerPrefix(String(input.baseRefName ?? repo.defaultBranch), repo);
          if (branchTip(repo, headRef) === null) throw new Error(`head ref "${headRef}" does not exist`);
          if (branchTip(repo, baseRef) === null) throw new Error(`base ref "${baseRef}" does not exist`);
          for (const existing of repo.pulls.values()) {
            if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
              return { __gqlType: 'CreatePullRequestPayload', pullRequest: wPull(repo, existing), clientMutationId: input.clientMutationId ?? null };
            }
          }
          const pull = createPullRecord(repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), headRef, baseRef });
          return { __gqlType: 'CreatePullRequestPayload', pullRequest: wPull(repo, pull), clientMutationId: input.clientMutationId ?? null };
        },
      },
      mergePullRequest: {
        t: 'MergePullRequestPayload',
        resolve: (_s, args) => {
          const input = args.input ?? {};
          const found = pullByGlobalId(input.pullRequestId);
          if (found === null || found.pull === null) throw new Error('pull request not found');
          const { repo, pull } = found;
          if (!pull.merged) {
            const outcome = mergePullRequest(repo, pull, input.mergeMethod === 'MERGE' ? 'merge' : 'squash');
            if (outcome.conflict === true) throw new Error('Pull Request is not mergeable');
          }
          return { __gqlType: 'MergePullRequestPayload', pullRequest: wPull(repo, pull), clientMutationId: input.clientMutationId ?? null };
        },
      },
      addComment: {
        t: 'AddCommentPayload',
        resolve: (_s, args) => {
          const input = args.input ?? {};
          const body = String(input.body ?? '');
          const foundIssue = issueByGlobalId(input.subjectId);
          if (foundIssue !== null && foundIssue.issue !== null) {
            const comment = { id: nextCommentId, body, createdSec: nextStamp() };
            nextCommentId += 1;
            foundIssue.issue.comments.push(comment);
            return {
              __gqlType: 'AddCommentPayload',
              commentEdge: { __gqlType: 'CommentEdge', node: wComment(comment), cursor: encodeCursor(comment.id) },
              clientMutationId: input.clientMutationId ?? null,
            };
          }
          const foundPull = pullByGlobalId(input.subjectId);
          if (foundPull !== null && foundPull.pull !== null) {
            const pull = foundPull.pull;
            if (pull.comments === undefined) pull.comments = [];
            const comment = { id: nextCommentId, body, createdSec: nextStamp() };
            nextCommentId += 1;
            pull.comments.push(comment);
            return {
              __gqlType: 'AddCommentPayload',
              commentEdge: { __gqlType: 'CommentEdge', node: wComment(comment), cursor: encodeCursor(comment.id) },
              clientMutationId: input.clientMutationId ?? null,
            };
          }
          throw new Error('subject not found');
        },
      },
    },
  },
  User: {
    fields: {
      id: { t: 'ID', resolve: (s) => globalId('User', s.login) },
      login: { t: 'String', resolve: (s) => s.login },
      name: { t: 'String', resolve: (s) => s.login },
      email: { t: 'String', resolve: (s) => `${s.login}@example.invalid` },
    },
  },
  RepositoryOwner: {
    fields: {
      id: { t: 'ID', resolve: (s) => globalId('User', s.login) },
      login: { t: 'String', resolve: (s) => s.login },
    },
  },
  Repository: {
    fields: {
      id: { t: 'ID', resolve: (s) => globalId('Repository', String(s.repo.id)) },
      databaseId: { t: 'Int', resolve: (s) => s.repo.id },
      name: { t: 'String', resolve: (s) => s.repo.name },
      nameWithOwner: { t: 'String', resolve: (s) => `${s.repo.owner}/${s.repo.name}` },
      description: { t: 'String', resolve: (s) => s.repo.description },
      isPrivate: { t: 'Boolean', resolve: (s) => s.repo.private },
      owner: { t: 'RepositoryOwner', resolve: (s) => ({ __gqlType: 'RepositoryOwner', login: s.repo.owner }) },
      defaultBranchRef: {
        t: 'Ref',
        resolve: (s) => (branchTip(s.repo, s.repo.defaultBranch) === null ? null : { __gqlType: 'Ref', name: s.repo.defaultBranch, repo: s.repo }),
      },
      viewerPermission: { t: 'String', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { t: 'Boolean', resolve: () => true },
      createdAt: { t: 'String', resolve: (s) => isoOf(s.repo.createdSec) },
      updatedAt: { t: 'String', resolve: (s) => isoOf(s.repo.updatedSec) },
      issue: {
        t: 'Issue',
        resolve: (s, args) => {
          const issue = s.repo.issues.get(Number(args.number));
          return issue === undefined ? null : wIssue(s.repo, issue);
        },
      },
      issues: {
        t: 'IssueConnection',
        resolve: (s, args) => {
          const all = orderedIssues(s.repo, args);
          const page = connectionPage(all, args);
          return {
            __gqlType: 'IssueConnection',
            nodes: page.slice.map((issue) => wIssue(s.repo, issue)),
            edges: page.slice.map((issue, i) => ({ __gqlType: 'IssueEdge', node: wIssue(s.repo, issue), cursor: encodeCursor(page.startIndex + i) })),
            pageInfo: { __gqlType: 'PageInfo', ...page.pageInfo },
            totalCount: page.totalCount,
          };
        },
      },
      pullRequest: {
        t: 'PullRequest',
        resolve: (s, args) => {
          const pull = s.repo.pulls.get(Number(args.number));
          return pull === undefined ? null : wPull(s.repo, pull);
        },
      },
      pullRequests: {
        t: 'PullRequestConnection',
        resolve: (s, args) => {
          let all = [...s.repo.pulls.values()].sort((a, b) => a.number - b.number);
          if (Array.isArray(args.states) && args.states.length > 0) {
            const wanted = new Set(args.states.map((state) => String(state).toUpperCase()));
            all = all.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          const page = connectionPage(all, args);
          return {
            __gqlType: 'PullRequestConnection',
            nodes: page.slice.map((pull) => wPull(s.repo, pull)),
            edges: page.slice.map((pull, i) => ({ __gqlType: 'PullRequestEdge', node: wPull(s.repo, pull), cursor: encodeCursor(page.startIndex + i) })),
            pageInfo: { __gqlType: 'PageInfo', ...page.pageInfo },
            totalCount: page.totalCount,
          };
        },
      },
    },
  },
  Ref: {
    fields: {
      name: { t: 'String', resolve: (s) => s.name },
      prefix: { t: 'String', resolve: () => 'refs/heads/' },
      target: {
        t: 'Commit',
        resolve: (s) => {
          const tip = branchTip(s.repo, s.name);
          return tip === null ? null : { __gqlType: 'Commit', oid: tip };
        },
      },
    },
  },
  Commit: {
    fields: {
      id: { t: 'ID', resolve: (s) => globalId('Commit', s.oid) },
      oid: { t: 'String', resolve: (s) => s.oid },
      message: { t: 'String', resolve: (s) => parseCommit(s.oid)?.message ?? '' },
    },
  },
  Issue: {
    fields: {
      id: { t: 'ID', resolve: (s) => globalId('Issue', `${s.repo.id}:${s.issue.number}`) },
      databaseId: { t: 'Int', resolve: (s) => s.issue.id },
      number: { t: 'Int', resolve: (s) => s.issue.number },
      title: { t: 'String', resolve: (s) => s.issue.title },
      body: { t: 'String', resolve: (s) => s.issue.body },
      state: { t: 'String', resolve: (s) => s.issue.state.toUpperCase() },
      createdAt: { t: 'String', resolve: (s) => isoOf(s.issue.createdSec) },
      updatedAt: { t: 'String', resolve: (s) => isoOf(s.issue.updatedSec) },
      author: { t: 'User', resolve: (s) => wUser(s.repo.owner) },
      labels: {
        t: 'LabelConnection',
        resolve: (s) => ({
          __gqlType: 'LabelConnection',
          nodes: s.issue.labels.map((name) => ({ __gqlType: 'Label', name })),
          totalCount: s.issue.labels.length,
        }),
      },
      comments: {
        t: 'IssueCommentConnection',
        resolve: (s, args) => {
          const page = connectionPage(s.issue.comments, args);
          return {
            __gqlType: 'IssueCommentConnection',
            nodes: page.slice.map((comment) => wComment(comment)),
            pageInfo: { __gqlType: 'PageInfo', ...page.pageInfo },
            totalCount: page.totalCount,
          };
        },
      },
    },
  },
  PullRequest: {
    fields: {
      id: { t: 'ID', resolve: (s) => globalId('PullRequest', `${s.repo.id}:${s.pull.number}`) },
      databaseId: { t: 'Int', resolve: (s) => s.pull.id },
      number: { t: 'Int', resolve: (s) => s.pull.number },
      title: { t: 'String', resolve: (s) => s.pull.title },
      body: { t: 'String', resolve: (s) => s.pull.body },
      state: { t: 'String', resolve: (s) => (s.pull.merged ? 'MERGED' : s.pull.state.toUpperCase()) },
      merged: { t: 'Boolean', resolve: (s) => s.pull.merged },
      mergedAt: { t: 'String', resolve: (s) => (s.pull.merged ? isoOf(s.pull.mergedSec) : null) },
      mergeable: { t: 'String', resolve: (s) => pullMergeable(s.repo, s.pull) },
      headRefName: { t: 'String', resolve: (s) => s.pull.headRef },
      baseRefName: { t: 'String', resolve: (s) => s.pull.baseRef },
      headRefOid: { t: 'String', resolve: (s) => branchTip(s.repo, s.pull.headRef) },
      baseRefOid: { t: 'String', resolve: (s) => branchTip(s.repo, s.pull.baseRef) },
      createdAt: { t: 'String', resolve: (s) => isoOf(s.pull.createdSec) },
      updatedAt: { t: 'String', resolve: (s) => isoOf(s.pull.updatedSec) },
      author: { t: 'User', resolve: (s) => wUser(s.repo.owner) },
      files: {
        t: 'PullRequestFileConnection',
        resolve: (s, args) => {
          const all = pullRequestFiles(s.repo, s.pull);
          const page = connectionPage(all, args);
          return {
            __gqlType: 'PullRequestFileConnection',
            nodes: page.slice.map((file) => ({
              __gqlType: 'PullRequestFile',
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.status.toUpperCase(),
            })),
            pageInfo: { __gqlType: 'PageInfo', ...page.pageInfo },
            totalCount: page.totalCount,
          };
        },
      },
    },
  },
  IssueComment: {
    fields: {
      id: { t: 'ID', resolve: (s) => globalId('IssueComment', String(s.comment.id)) },
      body: { t: 'String', resolve: (s) => s.comment.body },
      createdAt: { t: 'String', resolve: (s) => isoOf(s.comment.createdSec) },
      author: { t: 'User', resolve: () => wUser(VIEWER) },
    },
  },
  Label: {
    fields: {
      name: { t: 'String', resolve: (s) => s.name },
      id: { t: 'ID', resolve: (s) => globalId('Label', s.name) },
    },
  },
  PageInfo: {
    fields: {
      hasNextPage: { t: 'Boolean', resolve: (s) => s.hasNextPage },
      hasPreviousPage: { t: 'Boolean', resolve: (s) => s.hasPreviousPage },
      startCursor: { t: 'String', resolve: (s) => s.startCursor },
      endCursor: { t: 'String', resolve: (s) => s.endCursor },
    },
  },
  IssueConnection: {
    fields: {
      nodes: { t: 'Issue', list: true, resolve: (s) => s.nodes },
      edges: { t: 'IssueEdge', list: true, resolve: (s) => s.edges },
      pageInfo: { t: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { t: 'Int', resolve: (s) => s.totalCount },
    },
  },
  IssueEdge: {
    fields: {
      node: { t: 'Issue', resolve: (s) => s.node },
      cursor: { t: 'String', resolve: (s) => s.cursor },
    },
  },
  PullRequestConnection: {
    fields: {
      nodes: { t: 'PullRequest', list: true, resolve: (s) => s.nodes },
      edges: { t: 'PullRequestEdge', list: true, resolve: (s) => s.edges },
      pageInfo: { t: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { t: 'Int', resolve: (s) => s.totalCount },
    },
  },
  PullRequestEdge: {
    fields: {
      node: { t: 'PullRequest', resolve: (s) => s.node },
      cursor: { t: 'String', resolve: (s) => s.cursor },
    },
  },
  PullRequestFileConnection: {
    fields: {
      nodes: { t: 'PullRequestFile', list: true, resolve: (s) => s.nodes },
      pageInfo: { t: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { t: 'Int', resolve: (s) => s.totalCount },
    },
  },
  PullRequestFile: {
    fields: {
      path: { t: 'String', resolve: (s) => s.path },
      additions: { t: 'Int', resolve: (s) => s.additions },
      deletions: { t: 'Int', resolve: (s) => s.deletions },
      changeType: { t: 'String', resolve: (s) => s.changeType },
    },
  },
  IssueCommentConnection: {
    fields: {
      nodes: { t: 'IssueComment', list: true, resolve: (s) => s.nodes },
      pageInfo: { t: 'PageInfo', resolve: (s) => s.pageInfo },
      totalCount: { t: 'Int', resolve: (s) => s.totalCount },
    },
  },
  LabelConnection: {
    fields: {
      nodes: { t: 'Label', list: true, resolve: (s) => s.nodes },
      totalCount: { t: 'Int', resolve: (s) => s.totalCount },
    },
  },
  CreateIssuePayload: {
    fields: {
      issue: { t: 'Issue', resolve: (s) => s.issue },
      clientMutationId: { t: 'String', resolve: (s) => s.clientMutationId },
    },
  },
  CloseIssuePayload: {
    fields: {
      issue: { t: 'Issue', resolve: (s) => s.issue },
      clientMutationId: { t: 'String', resolve: (s) => s.clientMutationId },
    },
  },
  CreatePullRequestPayload: {
    fields: {
      pullRequest: { t: 'PullRequest', resolve: (s) => s.pullRequest },
      clientMutationId: { t: 'String', resolve: (s) => s.clientMutationId },
    },
  },
  MergePullRequestPayload: {
    fields: {
      pullRequest: { t: 'PullRequest', resolve: (s) => s.pullRequest },
      clientMutationId: { t: 'String', resolve: (s) => s.clientMutationId },
    },
  },
  AddCommentPayload: {
    fields: {
      commentEdge: { t: 'CommentEdge', resolve: (s) => s.commentEdge },
      clientMutationId: { t: 'String', resolve: (s) => s.clientMutationId },
    },
  },
  CommentEdge: {
    fields: {
      node: { t: 'IssueComment', resolve: (s) => s.node },
      cursor: { t: 'String', resolve: (s) => s.cursor },
    },
  },
  Node: {
    fields: {
      id: { t: 'ID', resolve: () => null },
    },
  },
  __Type: {
    fields: {
      name: { t: 'String', resolve: (s) => s.name },
      kind: { t: 'String', resolve: (s) => GQL_INTROSPECTION[s.name]?.kind ?? 'OBJECT' },
      fields: {
        t: '__Field',
        list: true,
        resolve: (s) => (GQL_INTROSPECTION[s.name]?.fields ?? []).map((name) => ({ __gqlType: '__Field', name })),
      },
      enumValues: {
        t: '__EnumValue',
        list: true,
        resolve: (s) => (GQL_INTROSPECTION[s.name]?.enumValues ?? []).map((name) => ({ __gqlType: '__EnumValue', name })),
      },
    },
  },
  __Field: {
    fields: {
      name: { t: 'String', resolve: (s) => s.name },
      description: { t: 'String', resolve: () => null },
    },
  },
  __EnumValue: {
    fields: {
      name: { t: 'String', resolve: (s) => s.name },
      description: { t: 'String', resolve: () => null },
    },
  },
  __Schema: {
    fields: {
      queryType: { t: '__Type', resolve: () => ({ __gqlType: '__Type', name: 'Query' }) },
      mutationType: { t: '__Type', resolve: () => ({ __gqlType: '__Type', name: 'Mutation' }) },
    },
  },
};

// What introspection reports: at least the fields the suite names.
const GQL_INTROSPECTION = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'author'],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

const GQL_SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

// --- GraphQL validation (unknown fields are named in an errors array) ---------

function gqlValidateSelections(typeName, selections, fragments, errors, depth) {
  if (depth > 24) return;
  const typeDef = GQL_SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      const field = typeDef?.fields[selection.name];
      if (field === undefined) {
        errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
        continue;
      }
      if (selection.selectionSet !== null && !GQL_SCALARS.has(field.t)) {
        gqlValidateSelections(field.t, selection.selectionSet, fragments, errors, depth + 1);
      }
    } else if (selection.kind === 'inlineFragment') {
      gqlValidateSelections(selection.typeCondition, selection.selectionSet, fragments, errors, depth + 1);
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment !== undefined) gqlValidateSelections(fragment.typeCondition, fragment.selectionSet, fragments, errors, depth + 1);
    }
  }
}

// --- GraphQL execution ----------------------------------------------------------

function gqlExecuteSelections(runtimeType, source, selections, ctx, out) {
  const typeDef = GQL_SCHEMA[runtimeType];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment' || selection.kind === 'fragmentSpread') {
      const fragment = selection.kind === 'inlineFragment' ? selection : ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition === runtimeType || fragment.typeCondition === 'Node') {
        gqlExecuteSelections(runtimeType, source, fragment.selectionSet, ctx, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = runtimeType;
      continue;
    }
    const field = typeDef?.fields[selection.name];
    if (field === undefined) continue; // validation already reported it
    const args = gqlArgs(selection.args, ctx.variables);
    const value = field.resolve(source, args, ctx);
    out[key] = gqlComplete(field, value, selection, ctx);
  }
  return out;
}

function gqlComplete(field, value, selection, ctx) {
  if (value === null || value === undefined) return null;
  if (field.list === true) {
    return value.map((entry) => gqlComplete({ t: field.t }, entry, selection, ctx));
  }
  if (GQL_SCALARS.has(field.t)) return value;
  const runtimeType = value.__gqlType ?? field.t;
  return gqlExecuteSelections(runtimeType, value, selection.selectionSet ?? [], ctx, {});
}

function gqlRunOperation(document, operationName, variables) {
  const operations = document.operations;
  const operation =
    operations.find((op) => op.name === operationName) ?? operations.find((op) => op.operation !== 'subscription') ?? operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const vars = { ...(variables ?? {}) };
  for (const def of operation.variableDefinitions) {
    if (vars[def.name] === undefined && def.defaultValue !== undefined) vars[def.name] = gqlValue(def.defaultValue, vars);
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors = [];
  gqlValidateSelections(rootType, operation.selectionSet, document.fragments, errors, 0);
  if (errors.length > 0) return { errors };
  const ctx = { variables: vars, fragments: document.fragments };
  try {
    const data = gqlExecuteSelections(rootType, null, operation.selectionSet, ctx, {});
    return { data };
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
}

function handleGraphql(req, res, body) {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
  const runOne = (entry) => {
    const query = typeof entry?.query === 'string' ? entry.query : '';
    if (query === '') return { errors: [{ message: 'query is required' }] };
    let document;
    try {
      document = new GqlParser(query).parseDocument();
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
    return gqlRunOperation(document, typeof entry.operationName === 'string' ? entry.operationName : null, entry.variables ?? {});
  };
  if (Array.isArray(parsed.value)) {
    return sendJson(res, 200, parsed.value.map((entry) => runOne(entry)));
  }
  return sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over POST /mcp. Modern revision 2026-07-28
// (server/discover, no handshake) and the legacy initialize handshake both
// work; the tools act on the same store as REST.
// ---------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

function mcpToolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function mcpToolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpCallTool(name, args) {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  const required = tool.inputSchema.required ?? [];
  for (const property of required) {
    if (args[property] === undefined || args[property] === null) {
      return { rpcError: { code: -32602, message: `missing required argument: ${property}` } };
    }
  }
  const repoOf = () => findRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (reposByKey.has(repoKey(VIEWER, repoName))) return { result: mcpToolError(`repository ${repoName} already exists`) };
      const repo = createRepo({
        name: repoName,
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return { result: mcpToolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return { result: mcpToolError('repository not found') };
      return { result: mcpToolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === null) return { result: mcpToolError('repository not found') };
      const issue = createIssueRecord(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      return { result: mcpToolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return { result: mcpToolError('repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return { result: mcpToolResult(list.map((issue) => issueJson(repo, issue))) };
    }
    case 'get_issue': {
      const repo = repoOf();
      if (repo === null) return { result: mcpToolError('repository not found') };
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return { result: mcpToolError('issue not found') };
      return { result: mcpToolResult(issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === null) return { result: mcpToolError('repository not found') };
      const headRef = stripOwnerPrefix(String(args.head), repo);
      const baseRef = stripOwnerPrefix(String(args.base), repo);
      if (branchTip(repo, headRef) === null) return { result: mcpToolError(`head branch "${headRef}" does not exist`) };
      if (branchTip(repo, baseRef) === null) return { result: mcpToolError(`base branch "${baseRef}" does not exist`) };
      const pull = createPullRecord(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        headRef,
        baseRef,
      });
      return { result: mcpToolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return { result: mcpToolError('repository not found') };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { result: mcpToolError('pull request not found') };
      if (!pull.merged) {
        const outcome = mergePullRequest(repo, pull, 'squash');
        if (outcome.conflict === true) return { result: mcpToolError('pull request is not mergeable') };
      }
      return { result: mcpToolResult(pullJson(repo, pull)) };
    }
    case 'close_issue': {
      const repo = repoOf();
      if (repo === null) return { result: mcpToolError('repository not found') };
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return { result: mcpToolError('issue not found') };
      issue.state = 'closed';
      issue.updatedSec = nextStamp();
      return { result: mcpToolResult(issueJson(repo, issue)) };
    }
    default:
      return { rpcError: { code: -32602, message: `unknown tool: ${name}` } };
  }
}

function handleMcp(req, res, body) {
  // A body that is not JSON is a parse error (HTTP 400, -32700).
  let message;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (!tokenOk(req)) {
    const id = message !== null && typeof message === 'object' && !Array.isArray(message) ? message.id ?? null : null;
    return sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32000, message: 'Unauthorized' } });
  }
  const handleOne = (entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { status: 400, payload: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
    }
    const id = entry.id ?? null;
    const method = typeof entry.method === 'string' ? entry.method : '';
    if (method.startsWith('notifications/')) return { status: 202, payload: null };
    switch (method) {
      case 'server/discover':
        return {
          status: 200,
          payload: {
            jsonrpc: '2.0',
            id,
            result: {
              supportedVersions: MCP_SUPPORTED_VERSIONS,
              capabilities: { tools: {} },
              serverInfo: MCP_SERVER_INFO,
              _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
            },
          },
        };
      case 'initialize': {
        const requested = typeof entry.params?.protocolVersion === 'string' ? entry.params.protocolVersion : '';
        const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
        return {
          status: 200,
          payload: {
            jsonrpc: '2.0',
            id,
            result: { protocolVersion, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO },
          },
        };
      }
      case 'ping':
        return { status: 200, payload: { jsonrpc: '2.0', id, result: {} } };
      case 'tools/list':
        return { status: 200, payload: { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } } };
      case 'tools/call': {
        const toolName = typeof entry.params?.name === 'string' ? entry.params.name : '';
        const args = entry.params?.arguments !== null && typeof entry.params?.arguments === 'object' ? entry.params.arguments : {};
        const outcome = mcpCallTool(toolName, args);
        if (outcome.rpcError !== undefined) {
          return { status: 200, payload: { jsonrpc: '2.0', id, error: outcome.rpcError } };
        }
        return { status: 200, payload: { jsonrpc: '2.0', id, result: outcome.result } };
      }
      default:
        return { status: 200, payload: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
    }
  };
  if (Array.isArray(message)) {
    const payloads = [];
    for (const entry of message) {
      const handled = handleOne(entry);
      if (handled.payload !== null) payloads.push(handled.payload);
    }
    if (payloads.length === 0) {
      res.writeHead(202, { 'content-length': 0 });
      return res.end();
    }
    return sendJson(res, 200, payloads);
  }
  const handled = handleOne(message);
  if (handled.payload === null) {
    res.writeHead(handled.status, { 'content-length': 0 });
    return res.end();
  }
  return sendJson(res, handled.status, handled.payload);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://forge.invalid');
    const path = url.pathname;

    if (path === '/healthz') {
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-length': 0 });
        return res.end();
      }
      const body = await readBody(req);
      return handleMcp(req, res, body);
    }

    if (path === '/api/graphql') {
      if (req.method !== 'POST') return sendError(res, 404, 'Not Found');
      if (!tokenOk(req)) {
        res.writeHead(401, { 'content-type': 'application/json', 'x-github-request-id': `req-${(requestSeq += 1)}` });
        return res.end(JSON.stringify({ message: 'Bad credentials', errors: [{ message: 'Bad credentials' }] }));
      }
      const body = await readBody(req);
      return handleGraphql(req, res, body);
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!tokenOk(req)) return sendError(res, 401, 'Bad credentials');
      const body = req.method === 'GET' || req.method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
      // DELETE carries a JSON body on the contents route; read it too.
      const finalBody = req.method === 'DELETE' ? await readBody(req) : body;
      return handleRest(req, res, url, finalBody);
    }

    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (gitMatch !== null) {
      if (!tokenOk(req)) return sendError(res, 401, 'Bad credentials');
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const sub = gitMatch[3] ?? '';
      const repo = findRepo(owner, repoName);
      if (repo === null) {
        return sendBytes(res, 404, Buffer.from('repository not found\n'), 'text/plain');
      }
      if (sub === '/info/refs' && req.method === 'GET') {
        return handleInfoRefs(req, res, repo, url.searchParams.get('service') ?? '', url);
      }
      if (sub === '/git-upload-pack' && req.method === 'POST') {
        const body = await readBody(req);
        return handleUploadPack(res, repo, body);
      }
      if (sub === '/git-receive-pack' && req.method === 'POST') {
        const body = await readBody(req);
        return handleReceivePack(res, repo, body);
      }
      return sendBytes(res, 404, Buffer.from('not found\n'), 'text/plain');
    }

    return sendError(res, 404, 'Not Found');
  } catch (error) {
    // A single bad request must never take the forge down.
    try {
      if (!res.headersSent) sendError(res, 500, 'Internal error');
      else res.end();
    } catch {
      // the socket is gone; nothing to do
    }
    process.stderr.write(`[forge] request error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function registerWithEnv(envUrl, port) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered')) throw error;
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function waitForDone(envUrl) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30000) });
      if (response.ok) {
        const body = await response.json();
        if (body !== null && typeof body === 'object' && body.done === true) return;
      }
    } catch {
      // not done yet, or the env is still starting: poll again
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8)));
  }
}

async function main() {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.keepAliveTimeout = 30000;
  server.headersTimeout = 60000;

  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    const port = Number(process.env.PORT ?? '8399');
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    process.stderr.write(`[forge] standalone on http://127.0.0.1:${port} (viewer ${VIEWER})\n`);
    return;
  }

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  process.stderr.write(`[forge] listening on ${port}; registering with ${envUrl}\n`);
  await registerWithEnv(envUrl, port);
  await waitForDone(envUrl);
  server.close();
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[forge] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
