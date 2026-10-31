import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Refusal } from './refusal.js';
import { ID_RE } from './links.js';

const SCHEMA = 1;
const rmrf = (p) => fsp.rm(p, { recursive: true, force: true });

/** `slug(title)` (at most 32 chars of [a-z0-9-]) plus a random base36 suffix. */
export function newId(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '') || 'artifact';
  return `${slug}-${crypto.randomInt(36 ** 6).toString(36).padStart(6, '0')}`;
}

/**
 * The on-disk artifact store. One promise-chain mutex serialises every mutation (single-process backend).
 * Layout: artifacts/<id>/artifact.json, artifacts/<id>/v/<n>/…, plus .staging/ and .trash/ scratch dirs.
 */
export class Store {
  #root;
  #chain = Promise.resolve();
  now;

  constructor(root, { now = () => new Date() } = {}) {
    this.#root = root;
    this.now = now;
  }

  /** Creates the layout and sweeps what a crash can leave behind. */
  static async open(root, opts) {
    const store = new Store(root, opts);
    await Promise.all(['artifacts', '.staging', '.trash'].map((d) => fsp.mkdir(path.join(root, d), { recursive: true })));
    await store.#sweep();
    return store;
  }

  #artifactDir = (id) => path.join(this.#root, 'artifacts', id);
  versionDir = (id, n) => path.join(this.#artifactDir(id), 'v', String(n));

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
    for (const id of await fsp.readdir(artifacts)) {
      const dir = path.join(artifacts, id);
      let text;
      try {
        text = await fsp.readFile(path.join(dir, 'artifact.json'), 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        await rmrf(dir); // a crash mid-create
        continue;
      }
      let record;
      try {
        record = JSON.parse(text);
      } catch (e) {
        console.error(`code-artifact: corrupt artifact.json for ${id} (left in place): ${e.message}`);
        continue;
      }
      const listed = new Set((record.versions ?? []).map((v) => String(v.n)));
      let onDisk = [];
      try {
        onDisk = await fsp.readdir(path.join(dir, 'v'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      for (const n of onDisk) if (!listed.has(n)) await rmrf(path.join(dir, 'v', n));
    }
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

  /** The record for `id`, or null when it is unknown (or corrupt, which is logged). */
  async get(id) {
    if (!ID_RE.test(id)) return null;
    try {
      return JSON.parse(await fsp.readFile(path.join(this.#artifactDir(id), 'artifact.json'), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`code-artifact: cannot read artifact ${id}: ${e.message}`);
      return null;
    }
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
      await fsp.rename(staging, this.versionDir(id, 1));
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
      await fsp.rename(staging, this.versionDir(id, n));
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
   * `dryRun` only reports. Resolves to `{versions: [{id, version}], artifacts}`.
   */
  prune({ olderThanDays, project, dryRun = false }) {
    return this.#lock(async () => {
      const cutoff = new Date(this.now().getTime() - olderThanDays * 86_400_000).toISOString();
      const picked = [];
      for (const r of await this.list({ project })) {
        for (const v of r.versions.slice(0, -1)) if (v.publishedAt < cutoff) picked.push({ id: r.id, version: v.n });
      }
      if (!dryRun) for (const { id, version } of picked) await this.#deleteVersion(id, version);
      return { versions: picked, artifacts: new Set(picked.map((p) => p.id)).size };
    });
  }
}
