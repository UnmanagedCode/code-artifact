import fsp from 'node:fs/promises';
import { Refusal } from './refusal.js';
import { KINDS, resolveKind } from './kinds.js';
import { inspectSource } from './source.js';
import { stageContent } from './ingest.js';
import { LIMITS } from './limits.js';
import { ID_RE, deepLink } from './links.js';

/** Upper bound for `olderThanDays` (about 270 years), so the cutoff is always a valid date. */
const MAX_PRUNE_DAYS = 100_000;
const PROJECT_RE = /^[a-zA-Z0-9._-]+$/;

const bad = (msg) => new Refusal('INVALID_ARGUMENT', msg);

/** Throws unless `args` is a plain object whose keys are all in `allowed`. */
function checkKeys(args, allowed) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw bad('arguments must be an object');
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw bad(`unknown argument ${k}`);
}

function str(args, key, { max, pattern, required = false } = {}) {
  const v = args[key];
  if (v === undefined) {
    if (required) throw bad(`${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length < 1 || v.length > max) throw bad(`${key} must be a string of 1-${max} characters`);
  if (pattern && !pattern.test(v)) throw bad(`${key} has an invalid format`);
  return v;
}

function int(args, key, { min = 1, required = false } = {}) {
  const v = args[key];
  if (v === undefined) {
    if (required) throw bad(`${key} is required`);
    return undefined;
  }
  if (!Number.isInteger(v) || v < min) throw bad(`${key} must be an integer >= ${min}`);
  return v;
}

function kindArg(args) {
  const v = args.kind;
  if (v !== undefined && !KINDS.includes(v)) throw bad(`kind must be one of ${KINDS.join(', ')}`);
  return v;
}

/** A record with its deep links added. */
export const withLinks = (r) => ({
  ...r,
  link: deepLink(r.id),
  versions: r.versions.map((v) => ({ ...v, versionLink: deepLink(r.id, v.n) })),
});

/**
 * The operations behind both the MCP tools and the REST API.
 * `store` is a Store, or a function returning one (it may throw STORE_UNCONFIGURED).
 */
export function createOps({ store: storeOrGetter, cc, limits = LIMITS }) {
  const getStore = () => (typeof storeOrGetter === 'function' ? storeOrGetter() : storeOrGetter);

  async function resolveProject(args, caller) {
    const explicit = args.project !== undefined;
    const project = args.project ?? caller?.project;
    if (!project || project.startsWith('.')) {
      throw new Refusal('PROJECT_REQUIRED', 'pass project: the caller has no user project (a conductor session must name one)');
    }
    if (explicit && !(await cc.projectExists(project))) throw new Refusal('PROJECT_UNKNOWN', `unknown project ${project}`);
    return project;
  }

  /** Stages `args.path` as `kind` and hands it to `commit`; the staging dir never outlives the call. */
  async function ingest(store, args, caller, storedKind, commit) {
    const sessionId = args.sessionId ?? caller?.sessionId ?? null;
    const info = await inspectSource(args.path, args.kind, limits);
    const kind = resolveKind(info, args.kind);
    if (storedKind && kind !== storedKind) {
      throw new Refusal('KIND_CHANGE', `the source looks like kind "${kind}" but the artifact is "${storedKind}"; pass kind:"${storedKind}" if that is what the source is`);
    }
    const staging = await store.newStaging();
    try {
      const staged = await stageContent(info, kind, staging, limits);
      const sessionLabel = await cc.sessionLabel(sessionId);
      const version = {
        sessionId, sessionLabel, source: { name: info.name, type: info.type },
        ...(staged.file ? { file: staged.file } : {}), bytes: staged.bytes, files: staged.files,
      };
      return await commit({ kind, version, staging });
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }

  const published = (record, extra) => {
    const v = record.versions[record.versions.length - 1];
    return {
      id: record.id, title: record.title, kind: record.kind, project: record.project, version: v.n, sessionId: v.sessionId,
      link: deepLink(record.id), versionLink: deepLink(record.id, v.n), bytes: v.bytes, files: v.files, ...extra,
    };
  };

  return {
    async publish(args, caller) {
      const store = getStore();
      checkKeys(args, ['path', 'title', 'kind', 'project', 'sessionId']);
      const path = str(args, 'path', { max: 4096, required: true });
      const title = str(args, 'title', { max: 200, required: true });
      kindArg(args);
      str(args, 'project', { max: 100, pattern: PROJECT_RE });
      str(args, 'sessionId', { max: 200 });
      const project = await resolveProject(args, caller);
      const record = await ingest(store, { ...args, path }, caller, null, ({ kind, version, staging }) =>
        store.create({ title, kind, project, version }, staging));
      return published(record);
    },

    async update(args, caller) {
      const store = getStore();
      checkKeys(args, ['artifact', 'path', 'title', 'kind', 'sessionId', 'project']);
      if ('project' in args) throw new Refusal('PROJECT_FIXED', 'an artifact keeps the project it was published under');
      const id = str(args, 'artifact', { max: 48, pattern: ID_RE, required: true });
      const path = str(args, 'path', { max: 4096, required: true });
      const title = str(args, 'title', { max: 200 });
      kindArg(args);
      str(args, 'sessionId', { max: 200 });
      const current = await store.get(id);
      if (!current) throw new Refusal('ARTIFACT_UNKNOWN', `no artifact ${id}`);
      const record = await ingest(store, { ...args, path }, caller, current.kind, ({ version, staging }) =>
        store.addVersion(id, { title, version }, staging));
      return published(record);
    },

    async list(args = {}) {
      checkKeys(args, ['project', 'kind']);
      const project = str(args, 'project', { max: 100, pattern: PROJECT_RE });
      const kind = kindArg(args);
      return { artifacts: (await getStore().list({ project, kind })).map(withLinks) };
    },

    async get(args) {
      checkKeys(args, ['artifact']);
      const id = str(args, 'artifact', { max: 48, pattern: ID_RE, required: true });
      const record = await getStore().get(id);
      if (!record) throw new Refusal('ARTIFACT_UNKNOWN', `no artifact ${id}`);
      return withLinks(record);
    },

    async remove(args) {
      checkKeys(args, ['artifact', 'version']);
      const id = str(args, 'artifact', { max: 48, pattern: ID_RE, required: true });
      const version = int(args, 'version');
      const store = getStore();
      if (version === undefined) {
        await store.deleteArtifact(id);
        return { deleted: 'artifact', id };
      }
      const record = await store.deleteVersion(id, version);
      return { deleted: 'version', id, version, latest: record.versions[record.versions.length - 1].n };
    },

    async prune(args) {
      checkKeys(args, ['olderThanDays', 'project', 'dryRun']);
      const olderThanDays = int(args, 'olderThanDays', { required: true });
      if (olderThanDays > MAX_PRUNE_DAYS) throw bad(`olderThanDays must be at most ${MAX_PRUNE_DAYS}`);
      const project = str(args, 'project', { max: 100, pattern: PROJECT_RE });
      if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw bad('dryRun must be a boolean');
      return getStore().prune({ olderThanDays, project, dryRun: args.dryRun === true });
    },
  };
}
