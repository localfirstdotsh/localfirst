import type { ReactNode } from 'react';
export function DetailsList({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return <dl className="definition-list browser-details-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? 'Not supplied'}</dd></div>)}</dl>;
}
