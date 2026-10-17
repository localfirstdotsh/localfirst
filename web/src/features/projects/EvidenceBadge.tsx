import { Badge } from '../../components/ui/Badge';
import { evidenceLabel } from '../../lib/format';

/** Exact backend level, human label, and a text-bearing badge (never color alone). */
export function EvidenceBadge({ level }: { level: string }) {
  return (
    <Badge>
      <span className="badge-dot" data-level={level} aria-hidden="true" />
      {evidenceLabel(level)}
    </Badge>
  );
}
