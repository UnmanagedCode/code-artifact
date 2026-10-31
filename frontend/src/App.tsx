import { useCallback, useEffect, useState } from 'react';
import { Trash2Icon } from 'lucide-react';
import { api } from '@/lib/api';
import { isEmbedded } from '@/lib/theme';
import { parseRoute, type ArtifactRec, type Route } from '@/lib/artifacts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ArtifactList } from '@/components/ArtifactList';
import { ArtifactDetail } from '@/components/ArtifactDetail';
import { ConfirmDialog, type ConfirmState } from '@/components/ConfirmDialog';
import { PruneDialog } from '@/components/PruneDialog';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.search));
  const [artifacts, setArtifacts] = useState<ArtifactRec[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pruneOpen, setPruneOpen] = useState(false);
  const embedded = isEmbedded();

  const load = useCallback(async () => {
    try {
      setArtifacts((await api<{ artifacts: ArtifactRec[] }>('api/artifacts')).artifacts);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = (search: string) => {
    history.pushState(null, '', search);
    setRoute(parseRoute(location.search));
  };
  const toList = () => go('?');

  const remove = (path: string) => api(path, { method: 'DELETE', headers: JSON_HEADERS });
  const ask = (state: ConfirmState) => { setConfirmError(null); setConfirm(state); };
  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    setConfirmError(null);
    try {
      await confirm.action();
      setConfirm(null);
      await load();
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const current = route.view === 'detail' ? artifacts?.find((a) => a.id === route.id) : undefined;

  let body;
  if (loadError) {
    body = (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
        </AlertDescription>
      </Alert>
    );
  } else if (!artifacts) {
    body = <p className="text-sm text-muted-foreground">Loading…</p>;
  } else if (route.view === 'detail') {
    body = current ? (
      <ArtifactDetail
        artifact={current}
        embedded={embedded}
        onBack={toList}
        onDeleteVersion={(n) => ask({
          title: `Delete v${n}?`,
          description: `Version ${n} of “${current.title}” is deleted for good. Its number is not reused.`,
          confirmLabel: 'Delete version',
          action: async () => { await remove(`api/artifacts/${current.id}/versions/${n}`); },
        })}
        onDeleteArtifact={() => ask({
          title: 'Delete artifact?',
          description: `“${current.title}” and all ${current.versions.length} of its versions are deleted for good.`,
          confirmLabel: 'Delete artifact',
          action: async () => { await remove(`api/artifacts/${current.id}`); toList(); },
        })}
      />
    ) : (
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">That artifact no longer exists.</p>
        <div><Button type="button" variant="outline" size="sm" onClick={toList}>Back to artifacts</Button></div>
      </div>
    );
  } else {
    body = <ArtifactList artifacts={artifacts} embedded={embedded} onOpenDetail={(id) => go(`?artifact=${encodeURIComponent(id)}`)} />;
  }

  return (
    <main className="mx-auto min-h-full w-full max-w-[var(--cc-session-width,48rem)] p-4 pb-12">
      {route.view === 'list' && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Artifacts</h1>
          <Button type="button" variant="outline" size="sm" onClick={() => setPruneOpen(true)} disabled={!artifacts?.length}>
            <Trash2Icon /> Delete old…
          </Button>
        </div>
      )}
      {body}
      <ConfirmDialog state={confirm} busy={busy} error={confirmError} onCancel={() => setConfirm(null)} onConfirm={() => void runConfirm()} />
      <PruneDialog
        open={pruneOpen}
        projects={[...new Set((artifacts ?? []).map((a) => a.project))].sort()}
        onClose={() => setPruneOpen(false)}
        onDone={() => { setPruneOpen(false); void load(); }}
      />
    </main>
  );
}
