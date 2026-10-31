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

/** `project` is the list filter, kept on the detail so its Back returns to the filtered list. */
export type Route = { view: 'list'; project: string | null } | { view: 'detail'; id: string; project: string | null };

/** The route held in the query string: `?artifact=<id>` is the detail view, anything else the list; `?project=<name>` filters. */
export function parseRoute(search: string): Route {
  const q = new URLSearchParams(search);
  const project = q.get('project') || null;
  const id = q.get('artifact');
  return id ? { view: 'detail', id, project } : { view: 'list', project };
}

/** The query string for a route: the single writer of the UI's own params, encoded so a name cannot inject another. */
export function routeSearch(route: Route): string {
  const q = new URLSearchParams();
  if (route.project) q.set('project', route.project);
  if (route.view === 'detail') q.set('artifact', route.id);
  return `?${q}`;
}

export const filterByProject = (artifacts: ArtifactRec[], project: string | null): ArtifactRec[] =>
  project === null ? artifacts : artifacts.filter((a) => a.project === project);

// cc's `menuItems` contract (cc docs/plugins.md) owns these names. The values are untrusted text, only ever rendered as text.
const MENU_PARAMS = { project: 'ccProject', worktree: 'ccWorktree' };

/**
 * What a cc ⋮ "Show artifacts" click asks for, or null when the query carries no menu param. A named project
 * shows its filtered list; a missing or empty name keeps `current` and reports a notice. The worktree is
 * ignored: artifacts belong to a project. `search` is the query to put in place of the cc one.
 */
export function menuArrival(search: string, current: Route): { route: Route; search: string; notice: string | null } | null {
  const q = new URLSearchParams(search);
  if (!q.has(MENU_PARAMS.project) && !q.has(MENU_PARAMS.worktree)) return null;
  const project = q.get(MENU_PARAMS.project) || null;
  const route: Route = project === null ? current : { view: 'list', project };
  const notice = project === null ? "Can't show artifacts: code-conductor named no project." : null;
  return { route, search: routeSearch(route), notice };
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

/** The longest session label shown, in code points; below cc's 80-character prompt preview so a cut preview is shortened with an ellipsis. */
export const MAX_SESSION_LABEL = 60;

/** A stored session label as plain, single-line text: markdown syntax removed. A label over `MAX_SESSION_LABEL` code points is cut to at most that many, backing up to the last space only when it falls past halfway, then `…` is appended. */
export function plainLabel(text: string): string {
  const stripped = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ''))
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)?/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|[\s(])[*_](?=\S)/g, '$1')
    .replace(/(?<=\S)[*_](?=[\s.,;:!?)]|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(stripped);
  if (chars.length <= MAX_SESSION_LABEL) return stripped;
  let cut = chars.slice(0, MAX_SESSION_LABEL);
  const space = cut.lastIndexOf(' ');
  if (space > MAX_SESSION_LABEL / 2) cut = cut.slice(0, space);
  return `${cut.join('').trimEnd()}…`;
}

/** The publishing session as plain text: its cleaned label, else the short id, else "unknown session". */
export function sessionText(v: Pick<VersionRec, 'sessionId' | 'sessionLabel'>): string {
  return plainLabel(v.sessionLabel ?? '') || (v.sessionId ? v.sessionId.slice(0, 8) : 'unknown session');
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
