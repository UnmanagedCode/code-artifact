import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Refusal } from './refusal.js';
import { ID_RE } from './links.js';
import { KINDS } from './kinds.js';
import { PREFIX_MODES } from './appManifest.js';

const SCHEMA = 1;
const isVersionNumber = (n) => Number.isInteger(n) && n >= 1;
const rmrf = (p) => fsp.rm(p, { recursive: true, force: true });

/** `slug(title)` (at most 32 chars of [a-z0-9-]) plus a random base36 suffix. */
export function newId(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '') || 'artifact';
  return `${slug}-${crypto.randomInt(36 ** 6).toString(36).padStart(6, '0')}`;
}

/** A reason `r` is not a well-formed record for `id`, or null. Guards every path built from a record. */
function recordProblem(r, id) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (r.id !== id || !ID_RE.test(r.id)) return 'id does not match its directory';
  if (!KINDS.includes(r.kind)) return 'unknown kind';
  if (typeof r.project !== 'string' || typeof r.title !== 'string') return 'project or title is not a string';
  if (!Array.isArray(r.versions) || r.versions.length === 0) return 'no versions';
  let prev = 0;
  for (const v of r.versions) {
    if (v === null || typeof v !== 'object' || !isVersionNumber(v.n)) return 'a version number is not a positive integer';
    if (v.n <= prev) return 'version numbers are not ascending';
    if (typeof v.title !== 'string' || typeof v.publishedAt !== 'string' || Number.isNaN(Date.parse(v.publishedAt))) return 'a version has no valid title or publishedAt';
    if (r.kind === 'app') {
      const a = v.app;
      if (a === null || typeof a !== 'object' || typeof a.start !== 'string' || !PREFIX_MODES.includes(a.prefix)
        || (a.install !== undefined && typeof a.install !== 'string')) return 'an app version has no valid app manifest';
    }
    prev = v.n;
  }
  if (!isVersionNumber(r.nextVersion) || r.nextVersion <= prev) return 'nextVersion does not follow the versions';
  return null;
}

/**
 * The on-disk artifact store. One promise-chain mutex serialises every mutation (single-process backend).
 * Layout: artifacts/<id>/artifact.json, artifacts/<id>/v/<n>/…, plus .staging/ and .trash/ scratch dirs.
 */
export class Store {
  #root;
  #chain = Promise.resolve();
  now;

  #moveIntoPlace;

  // `moveIntoPlace` is a test seam: the step that makes staged content a version directory.
  constructor(root, { now = () => new Date(), moveIntoPlace = (from, to) => fsp.rename(from, to) } = {}) {
    this.#root = root;
    this.now = now;
    this.#moveIntoPlace = moveIntoPlace;
  }

  /** Creates the layout and sweeps what a crash can leave behind. */
  static async open(root, opts) {
    const store = new Store(root, opts);
    await Promise.all(['artifacts', '.staging', '.trash'].map((d) => fsp.mkdir(path.join(root, d), { recursive: true })));
    await store.#sweep();
    return store;
  }

  #artifactDir = (id) => path.join(this.#root, 'artifacts', id);
  versionDir = (id, n) => {
    if (!ID_RE.test(id) || !isVersionNumber(n)) throw new Error(`invalid artifact or version: ${id} v${n}`);
    return path.join(this.#artifactDir(id), 'v', String(n));
  };

  /** The working copy an app runs from (created at first Start, never part of the published tree). */
  runDir = (id, n) => path.join(this.versionDir(id, n), 'run');
  /** Present once `runDir`'s install succeeded. */
  installedMarker = (id, n) => path.join(this.versionDir(id, n), 'installed');
  /** An app's persistent state: survives updates, removed with the artifact. */
  dataDir = (id) => this.#artifactFile(id, 'data');
  logFile = (id) => this.#artifactFile(id, 'app.log');
  #artifactFile = (id, name) => {
    if (!ID_RE.test(id)) throw new Error(`invalid artifact: ${id}`);
    return path.join(this.#artifactDir(id), name);
  };

  #lock(fn) {
    const run = this.#chain.then(fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #sweep() {
    for (const scratch of ['.staging', '.trash']) {
      const dir = path.join(this.#root, scratch);
      for (const name of await fsp.readdir(dir)) await rmrf(path.join(dir, name));
    }
    const artifacts = path.join(this.#root, 'artifacts');
    for (const entry of await fsp.readdir(artifacts, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(artifacts, entry.name);
      const loaded = await this.#load(entry.name);
      if (loaded.status === 'missing') {
        await rmrf(dir); // a crash mid-create
        continue;
      }
      if (loaded.status !== 'ok') continue;
      const listed = new Set(loaded.record.versions.map((v) => String(v.n)));
      let onDisk = [];
      try {
        onDisk = await fsp.readdir(path.join(dir, 'v'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      for (const n of onDisk) if (!listed.has(n)) await rmrf(path.join(dir, 'v', n));
    }
  }

  /** Reads and validates a record: `{status:'ok', record}`, `{status:'missing'}` or `{status:'corrupt'}` (logged, never deleted). */
  async #load(id) {
    let text;
    try {
      text = await fsp.readFile(path.join(this.#artifactDir(id), 'artifact.json'), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { status: 'missing' };
      console.error(`code-artifact: cannot read artifact ${id} (left in place): ${e.message}`);
      return { status: 'corrupt' };
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch (e) {
      console.error(`code-artifact: corrupt artifact.json for ${id} (left in place): ${e.message}`);
      return { status: 'corrupt' };
    }
    const problem = recordProblem(record, id);
    if (problem) {
      console.error(`code-artifact: malformed artifact.json for ${id} (left in place): ${problem}`);
      return { status: 'corrupt' };
    }
    return { status: 'ok', record };
  }

  /** A fresh scratch dir for ingest; `create`/`addVersion` rename it into place. */
  newStaging() {
    return fsp.mkdtemp(path.join(this.#root, '.staging', 'ingest-'));
  }

  async #write(record) {
    const dir = this.#artifactDir(record.id);
    const tmp = path.join(dir, `artifact.json.tmp-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2));
    await fsp.rename(tmp, path.join(dir, 'artifact.json'));
  }

  /** The record for `id`, or null when it is unknown or corrupt (which is logged). */
  async get(id) {
    if (!ID_RE.test(id)) return null;
    const loaded = await this.#load(id);
    return loaded.status === 'ok' ? loaded.record : null;
  }

  /** Every readable artifact, newest latest-version first. Corrupt records are logged and skipped. */
  async list({ project, kind } = {}) {
    const out = [];
    for (const id of await fsp.readdir(path.join(this.#root, 'artifacts'))) {
      const record = await this.get(id);
      if (!record) continue;
      if (project !== undefined && record.project !== project) continue;
      if (kind !== undefined && record.kind !== kind) continue;
      out.push(record);
    }
    const latestAt = (r) => r.versions[r.versions.length - 1].publishedAt;
    return out.sort((a, b) => latestAt(b).localeCompare(latestAt(a)));
  }

  /** Publishes `staging` as version 1 of a new artifact. `version` carries the per-version fields except n and publishedAt. */
  create({ title, kind, project, version }, staging) {
    return this.#lock(async () => {
      let id = newId(title);
      while (await this.get(id)) id = newId(title);
      const at = this.now().toISOString();
      const record = {
        schema: SCHEMA, id, kind, project, title, createdAt: at, nextVersion: 2,
        versions: [{ n: 1, title, publishedAt: at, ...version }],
      };
      await fsp.mkdir(path.join(this.#artifactDir(id), 'v'), { recursive: true });
      await this.#moveIntoPlace(staging, this.versionDir(id, 1));
      await this.#write(record);
      return record;
    });
  }

  /** Publishes `staging` as the next version of `id`; `title`, when given, becomes the current title. */
  addVersion(id, { title, version }, staging) {
    return this.#lock(async () => {
      const record = await this.get(id);
      if (!record) throw new Refusal('ARTIFACT_UNKNOWN', `no artifact ${id}`);
      const n = record.nextVersion;
      const t = title ?? record.title;
      await this.#moveIntoPlace(staging, this.versionDir(id, n));
      const next = {
        ...record, title: t, nextVersion: n + 1,
        versions: [...record.versions, { n, title: t, publishedAt: this.now().toISOString(), ...version }],
      };
      await this.#write(next);
      return next;
    });
  }

  /** Removes one version; the record is rewritten before the directory goes. */
  deleteVersion(id, n) {
    return this.#lock(() => this.#deleteVersion(id, n));
  }

  async #deleteVersion(id, n) {
    const record = await this.get(id);
    if (!record) throw new Refusal('ARTIFACT_UNKNOWN', `no artifact ${id}`);
    if (!record.versions.some((v) => v.n === n)) throw new Refusal('VERSION_UNKNOWN', `artifact ${id} has no version ${n}`);
    if (record.versions.length === 1) throw new Refusal('LAST_VERSION', 'cannot delete the only remaining version; delete the artifact instead');
    const next = { ...record, versions: record.versions.filter((v) => v.n !== n) };
    await this.#write(next);
    await rmrf(this.versionDir(id, n));
    return next;
  }

  /** Removes a whole artifact: renamed into .trash/, then deleted. */
  deleteArtifact(id) {
    return this.#lock(async () => {
      if (!(await this.get(id))) throw new Refusal('ARTIFACT_UNKNOWN', `no artifact ${id}`);
      const trash = path.join(this.#root, '.trash', `${id}-${crypto.randomBytes(4).toString('hex')}`);
      await fsp.rename(this.#artifactDir(id), trash);
      await rmrf(trash);
    });
  }

  /**
   * Versions published more than `olderThanDays` days ago, never an artifact's latest.
   * `keep(id, n)` returning true spares a version. `dryRun` only reports. Resolves to `{versions: [{id, version}], artifacts}`.
   */
  prune({ olderThanDays, project, dryRun = false, keep = () => false }) {
    return this.#lock(async () => {
      const cutoff = new Date(this.now().getTime() - olderThanDays * 86_400_000).toISOString();
      const picked = [];
      for (const r of await this.list({ project })) {
        for (const v of r.versions.slice(0, -1)) if (v.publishedAt < cutoff && !keep(r.id, v.n)) picked.push({ id: r.id, version: v.n });
      }
      if (!dryRun) for (const { id, version } of picked) await this.#deleteVersion(id, version);
      return { versions: picked, artifacts: new Set(picked.map((p) => p.id)).size };
    });
  }
}
