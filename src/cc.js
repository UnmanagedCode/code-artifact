import { Refusal } from './refusal.js';

/**
 * A client for the few conductor REST reads the plugin needs. `baseUrl` null means standalone:
 * project checks are skipped and session labels are unknown.
 */
export function createCc(baseUrl, { timeoutMs = 2000 } = {}) {
  let warnedStandalone = false;
  const get = (p) => fetch(`${baseUrl}${p}`, { signal: AbortSignal.timeout(timeoutMs) });

  return {
    /** Whether cc knows `name`. Skipped (true) standalone; throws CC_UNREACHABLE when cc cannot answer. */
    async projectExists(name) {
      if (!baseUrl) {
        if (!warnedStandalone) console.warn('code-artifact: CONDUCTOR_URL is unset; explicit project names are not verified');
        warnedStandalone = true;
        return true;
      }
      let res;
      try {
        res = await get(`/api/projects/${encodeURIComponent(name)}/location`);
      } catch (e) {
        throw new Refusal('CC_UNREACHABLE', `cannot reach the conductor to verify project ${name}: ${e.message}`);
      }
      if (res.status === 404) return false;
      if (!res.ok) throw new Refusal('CC_UNREACHABLE', `the conductor answered ${res.status} when verifying project ${name}`);
      return true;
    },

    /** The session's display label, or null (logged) when it cannot be read. */
    async sessionLabel(sessionId) {
      if (!baseUrl || !sessionId) return null;
      try {
        const res = await get('/api/instances');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        return rows.find((r) => r.sessionId === sessionId)?.displayLabel ?? null;
      } catch (e) {
        console.warn(`code-artifact: cannot read the session label: ${e.message}`);
        return null;
      }
    },
  };
}
