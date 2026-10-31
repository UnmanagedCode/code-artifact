import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AppStatusBadge } from '@/components/AppPanel';
import { groupByProject, latestOf, openHref, relativeTime, sessionText, type ArtifactRec } from '@/lib/artifacts';

export function ArtifactList({ artifacts, embedded, onOpenDetail }: {
  artifacts: ArtifactRec[];
  embedded: boolean;
  onOpenDetail: (id: string) => void;
}) {
  if (artifacts.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        <p>No artifacts yet. An agent publishes one with the <code className="font-mono">publish_artifact</code> tool.</p>
      </Card>
    );
  }
  return (
    <div className="grid gap-6">
      {groupByProject(artifacts).map(({ project, artifacts: rows }) => (
        <section key={project} aria-label={project} className="grid min-w-0 gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">{project}</h2>
          {rows.map((a) => {
            const v = latestOf(a);
            return (
              <Card key={a.id} className="flex min-w-0 flex-row flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <a
                    href={`?artifact=${encodeURIComponent(a.id)}`}
                    onClick={(e) => { e.preventDefault(); onOpenDetail(a.id); }}
                    className="block truncate font-medium hover:underline"
                  >
                    {a.title}
                  </a>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <Badge variant="secondary">{a.kind}</Badge>
                    {a.app && <AppStatusBadge status={a.app.status} />}
                    <span>v{v.n}</span>
                    <span>{relativeTime(v.publishedAt)}</span>
                    <span className="truncate">{sessionText(v)}</span>
                  </div>
                </div>
                <Button asChild variant="outline" size="sm">
                  <a href={openHref(embedded, a)}>Open</a>
                </Button>
              </Card>
            );
          })}
        </section>
      ))}
    </div>
  );
}
