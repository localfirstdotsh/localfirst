import Link from 'next/link';
import { humanize, meaningfulUsage, testSupportSummary } from '../../lib/format';
import type { ProjectSummary } from '../../lib/schemas';
import { StatusIndicator } from '../../components/StatusIndicator';

const ICONS: Record<string, string> = {
  application: 'M3 4h14v10H3zM7 17h6',
  workflow: 'M4 4h4v4H4zM12 12h4v4h-4zM8 6h4a2 2 0 0 1 2 2v4',
  demo: 'M7 4.5v11l9-5.5z',
  robotics: 'M6 7h8v7H6zM10 7V4M8.5 10.5h.01M11.5 10.5h.01',
  experiment: 'M8 3h4M9 3v5l-4 7a1 1 0 0 0 1 1.5h8a1 1 0 0 0 1-1.5l-4-7V3',
  hardware_build: 'M6 6h8v8H6zM9 3v3M11 3v3M9 14v3M11 14v3M3 9h3M3 11h3M14 9h3M14 11h3',
  documentation: 'M5 3h7l3 3v11H5zM12 3v3h3M8 10h4M8 13h4',
};

function TypeIcon({ type }: { type: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[type] ?? ICONS.documentation} />
    </svg>
  );
}

/**
 * One catalog result: what it is, what it runs on, how far to trust it. The title link is
 * stretched over the whole row, so the row is a single target with no nested controls.
 * Everything shown comes from the project's own metadata; absent fields are left out.
 */
export function ProjectResult({ project }: { project: ProjectSummary }) {
  const compatibility = [...project.runtime_families, ...project.operating_systems, ...project.architectures];
  const test = project.test_support.declared_kind !== 'none' ? testSupportSummary(project.test_support) : null;
  const usage = meaningfulUsage(project.usage);
  return (
    <li className="result">
      <span className="result-icon">
        <TypeIcon type={project.type} />
      </span>
      <div className="result-body">
        <div className="result-heading">
        <h3 className="result-title">
          <Link href={`/projects/${encodeURIComponent(project.slug)}`}>{project.name}</Link>
        </h3>
        <span className="result-kind">{humanize(project.type)}</span>
        </div>
        <p className="result-summary">{project.summary}</p>
        {compatibility.length > 0 && (
          <ul className="dot-list" aria-label="Compatibility">
            {compatibility.map((value) => (
              <li key={value}>{humanize(value)}</li>
            ))}
          </ul>
        )}
        <p className="result-trust">
          <StatusIndicator level={project.evidence_level} />
          {test && <span>{test}</span>}
          {usage && <span>{usage}</span>}
        </p>
      </div>
      <span className="result-arrow" aria-hidden="true">
        →
      </span>
    </li>
  );
}
