import { formatCount } from '../../lib/format';
export function UsageChart({ id, title, kind, values, firstDay, lastDay }: { id: string; title: string; kind: 'exports' | 'retrievals'; values: number[]; firstDay: string; lastDay: string }) {
  const width = 600, plotTop = 4, plotHeight = 100;
  const max = Math.max(0, ...values), slot = width / Math.max(1, values.length);
  const barWidth = Math.max(1, Math.floor(slot - Math.min(3, slot * 0.25)));
  const description = `${formatCount(values.reduce((sum, value) => sum + value, 0))} in total over ${values.length} days from ${firstDay} to ${lastDay}; the busiest day had ${formatCount(max)}.`;
  return <figure className="usage-chart"><figcaption>{title} <span className="small muted">Busiest day: {formatCount(max)}</span></figcaption>
    <svg className="chart" viewBox={`0 0 ${width} ${plotTop + plotHeight + 2}`} role="img" aria-labelledby={`${id}-title ${id}-desc`} preserveAspectRatio="none">
      <title id={`${id}-title`}>{title} per day</title><desc id={`${id}-desc`}>{description}</desc>
      {values.map((value, index) => {
        if (value <= 0) return null;
        const height = Math.max(2, Math.round(value / max * plotHeight));
        return <rect key={index} className={`bar bar-${kind}`} x={Math.round(index * slot)} y={plotTop + plotHeight - height} width={barWidth} height={height} />;
      })}
      <line className="axis" x1={0} y1={plotTop + plotHeight} x2={width} y2={plotTop + plotHeight} />
    </svg>
    <div className="browser-actions small muted" aria-hidden="true"><span>{firstDay}</span><span>{lastDay}</span></div>
  </figure>;
}
