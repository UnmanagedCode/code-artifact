import { useEffect, useState } from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

interface PruneResult {
  versions: { id: string; version: number }[];
  artifacts: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const post = (body: object) => api<PruneResult>('api/prune', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

/** Bulk delete of old versions, with a live dry-run count. Every artifact keeps its latest version. */
export function PruneDialog({ open, projects, onClose, onDone }: {
  open: boolean;
  projects: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [days, setDays] = useState('30');
  const [project, setProject] = useState('');
  const [preview, setPreview] = useState<PruneResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1;
  const scope = project ? { project } : {};

  useEffect(() => {
    if (!open || !valid) { setPreview(null); return; }
    let stale = false;
    setError(null);
    post({ olderThanDays: n, dryRun: true, ...scope })
      .then((r) => { if (!stale) setPreview(r); })
      .catch((e: Error) => { if (!stale) { setPreview(null); setError(e.message); } });
    return () => { stale = true; };
  }, [open, n, valid, project]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await post({ olderThanDays: n, ...scope });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const count = preview?.versions.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete old versions</DialogTitle>
          <DialogDescription>Removes versions published more than the given number of days ago.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="prune-days">Older than (days)</Label>
            <Input id="prune-days" type="number" inputMode="numeric" min={1} step={1} value={days} onChange={(e) => setDays(e.target.value)} aria-invalid={!valid} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="prune-project">Project</Label>
            <NativeSelect id="prune-project" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </NativeSelect>
          </div>
          <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="prune-preview">
            {!valid ? 'Enter a whole number of days, at least 1.'
              : preview ? `Deletes ${count} version${count === 1 ? '' : 's'} across ${preview.artifacts} artifact${preview.artifacts === 1 ? '' : 's'}; every artifact keeps its latest version.`
              : 'Counting…'}
          </p>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={run} disabled={busy || !valid || count === 0}>
            {busy && <LoaderCircleIcon className="animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
