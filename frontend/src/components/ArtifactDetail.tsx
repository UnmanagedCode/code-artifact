import { ArrowLeftIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatBytes, openHref, relativeTime, sessionText, type AppStatus, type ArtifactRec } from '@/lib/artifacts';
import { AppPanel } from '@/components/AppPanel';

export function ArtifactDetail({ artifact: a, embedded, onBack, onAppStatus, onDeleteVersion, onDeleteArtifact }: {
  artifact: ArtifactRec;
  embedded: boolean;
  onAppStatus: (id: string, status: AppStatus) => void;
  onBack: () => void;
  onDeleteVersion: (n: number) => void;
  onDeleteArtifact: () => void;
}) {
  const newestFirst = [...a.versions].reverse();
  const latestN = newestFirst[0].n;
  return (
    <div className="grid gap-4">
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}><ArrowLeftIcon /> Artifacts</Button>
      </div>
      <header className="grid min-w-0 gap-1">
        <h1 className="text-xl font-semibold break-words">{a.title}</h1>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge variant="secondary">{a.kind}</Badge>
          <span>{a.project}</span>
          <code className="font-mono break-all">{a.id}</code>
        </div>
      </header>
      {a.kind === 'app' && <AppPanel artifact={a} embedded={embedded} onStatus={onAppStatus} />}
      <section aria-label="Versions" className="grid min-w-0 gap-2">
        {newestFirst.map((v) => (
          <Card key={v.n} className="grid min-w-0 gap-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">v{v.n}</span>
              {v.n === latestN && <Badge variant="default">latest</Badge>}
              {v.title !== a.title && <span className="text-sm break-words">{v.title}</span>}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{relativeTime(v.publishedAt)}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{sessionText(v)}</span>
              <span>{formatBytes(v.bytes)}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm"><a href={openHref(embedded, a, v)}>Open</a></Button>
              <Button asChild variant="outline" size="sm"><a href={`dl/${a.id}/${v.n}`}>Download</a></Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={a.versions.length === 1}
                title={a.versions.length === 1 ? 'delete the artifact instead' : undefined}
                onClick={() => onDeleteVersion(v.n)}
              >
                Delete
              </Button>
            </div>
          </Card>
        ))}
      </section>
      <div>
        <Button type="button" variant="destructive" size="sm" onClick={onDeleteArtifact}>Delete artifact</Button>
      </div>
    </div>
  );
}
