// Pure UI logic: no imports, so Node imports this file directly in tests.

export type AppState = 'stopped' | 'installing' | 'starting' | 'running' | 'failed';

/** A live process state, as the backend reports it on an app record. */
export interface AppStatus {
  status: AppState;
  version: number | null;
  error: string | null;
  since: string;
}

/** The artifact.json an app version was published with. */
export interface AppManifest {
  start: string;
  install?: string;
  prefix: 'strip' | 'keep';
}

export interface VersionRec {
  n: number;
  title: string;
  publishedAt: string;
  sessionId: string | null;
  sessionLabel: string | null;
  source: { name: string; type: string };
  file?: string;
  bytes: number;
  files: number;
  app?: AppManifest;
  versionLink: string;
}

export interface ArtifactRec {
  id: string;
  kind: string;
  project: string;
  title: string;
  createdAt: string;
  versions: VersionRec[];
  link: string;
  app?: AppStatus;
}

export type Route = { view: 'list' } | { view: 'detail'; id: string };

/** The route held in the query string: `?artifact=<id>` is the detail view, anything else the list. */
export function parseRoute(search: string): Route {
  const id = new URLSearchParams(search).get('artifact');
  return id ? { view: 'detail', id } : { view: 'list' };
}

export const latestOf = (a: ArtifactRec): VersionRec => a.versions[a.versions.length - 1];

/** Artifacts grouped by project: projects by name, artifacts newest latest-version first. */
export function groupByProject(artifacts: ArtifactRec[]): { project: string; artifacts: ArtifactRec[] }[] {
  const groups = new Map<string, ArtifactRec[]>();
  for (const a of artifacts) groups.set(a.project, [...(groups.get(a.project) ?? []), a]);
  return [...groups.keys()]
    .sort((x, y) => x.localeCompare(y))
    .map((project) => ({
      project,
      artifacts: groups.get(project)!.sort((x, y) => latestOf(y).publishedAt.localeCompare(latestOf(x).publishedAt)),
    }));
}

/** Where an Open link goes: cc's deep link when embedded (the bridge turns it into in-app navigation), a relative URL standalone. */
export function openHref(embedded: boolean, a: Pick<ArtifactRec, 'id' | 'link'>, version?: Pick<VersionRec, 'n' | 'versionLink'>): string {
  if (embedded) return version ? version.versionLink : a.link;
  return version ? `a/${a.id}/v/${version.n}/` : `a/${a.id}/`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** The publishing session as text: its label, else the short id, else "unknown session". */
export function sessionText(v: Pick<VersionRec, 'sessionId' | 'sessionLabel'>): string {
  return v.sessionLabel || (v.sessionId ? v.sessionId.slice(0, 8) : 'unknown session');
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const units: [number, string][] = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']];
  let best = units[0];
  for (const u of units) if (s >= u[0]) best = u;
  const n = Math.floor(s / best[0]);
  return `${n} ${best[1]}${n === 1 ? '' : 's'} ago`;
}

/** Which process controls apply: Start from stopped or failed, Stop while installing, starting or running. */
export function appActions(status: AppState): { start: boolean; stop: boolean } {
  return { start: status === 'stopped' || status === 'failed', stop: status === 'installing' || status === 'starting' || status === 'running' };
}

/** A state that changes by itself soon, so the status is polled fast. */
export const isTransient = (status: AppState): boolean => status === 'installing' || status === 'starting';

const STATUS_LABELS: Record<AppState, string> = {
  stopped: 'Stopped', installing: 'Installing…', starting: 'Starting…', running: 'Running', failed: 'Failed',
};
export const statusLabel = (status: AppState): string => STATUS_LABELS[status];
