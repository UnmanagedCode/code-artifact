import { useCallback, useEffect, useRef, useState } from 'react';
import { PlayIcon, SquareIcon } from 'lucide-react';
import { api, apiText } from '@/lib/api';
import { appActions, isTransient, latestOf, openHref, statusLabel, type AppState, type AppStatus, type ArtifactRec } from '@/lib/artifacts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const TONES: Record<AppState, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  stopped: 'secondary', installing: 'warning', starting: 'warning', running: 'success', failed: 'destructive',
};

export function AppStatusBadge({ status }: { status: AppState }) {
  return <Badge variant={TONES[status]}>{statusLabel(status)}</Badge>;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const FAST_MS = 1000;
const SLOW_MS = 5000;

/** An app's process controls: live status, Start/Stop, Open, the manifest it runs from, and its log tail. */
export function AppPanel({ artifact: a, embedded, onStatus }: {
  artifact: ArtifactRec;
  embedded: boolean;
  onStatus: (id: string, status: AppStatus) => void;
}) {
  const [status, setStatus] = useState<AppStatus | null>(a.app ?? null);
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const manifest = latestOf(a).app;
  const base = `api/apps/${a.id}`;

  const refresh = useCallback(async () => {
    try {
      const next = await api<AppStatus>(base);
      setStatus(next);
      onStatus(a.id, next);
      setLog(await apiText(`${base}/log?bytes=65536`));
    } catch {
      // The backend is briefly away; the next tick retries.
    }
  }, [a.id, base, onStatus]);

  const state = status?.status ?? 'stopped';
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let live = true;
    const tick = async () => {
      await refresh();
      if (live) timer = setTimeout(() => void tick(), isTransient(state) ? FAST_MS : SLOW_MS);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
  }, [refresh, state]);

  useEffect(() => {
    const pre = logRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [log]);

  async function act(what: 'start' | 'stop') {
    setBusy(true);
    setError(null);
    try {
      const next = await api<AppStatus>(`${base}/${what}`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
      setStatus(next);
      onStatus(a.id, next);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const actions = appActions(state);
  return (
    <section aria-label="App" className="grid gap-3">
      <Card className="grid gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <AppStatusBadge status={state} />
          {status?.version != null && <span className="text-xs text-muted-foreground">v{status.version}</span>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy || !actions.start} onClick={() => void act('start')}><PlayIcon /> Start</Button>
            <Button type="button" variant="outline" size="sm" disabled={busy || !actions.stop} onClick={() => void act('stop')}><SquareIcon /> Stop</Button>
            <Button asChild variant="outline" size="sm"><a href={openHref(embedded, a)}>Open</a></Button>
          </div>
        </div>
        {(error || status?.error) && (
          <Alert variant="destructive"><AlertDescription className="break-words">{error ?? status?.error}</AlertDescription></Alert>
        )}
        {manifest && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">start</dt><dd><code className="font-mono break-all">{manifest.start}</code></dd>
            {manifest.install && (<><dt className="text-muted-foreground">install</dt><dd><code className="font-mono break-all">{manifest.install}</code></dd></>)}
            <dt className="text-muted-foreground">prefix</dt><dd><code className="font-mono">{manifest.prefix}</code></dd>
          </dl>
        )}
      </Card>
      <div className="grid gap-1">
        <h2 className="text-sm font-medium text-muted-foreground">Logs</h2>
        <pre
          ref={logRef}
          aria-label="App log"
          className="max-h-80 min-h-16 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs leading-snug whitespace-pre-wrap break-words"
        >
          {log || 'No output yet.'}
        </pre>
      </div>
    </section>
  );
}
