import Link from 'next/link';
import { ReferenceError } from './ReferenceStates';
import { DiscoveryState } from '../../components/layout/DiscoveryPage';
import { EmptyState } from '../../components/composites/EmptyState';
import { buttonClassName } from '../../components/ui/Button';
import { REFERENCE_LIST_LIMIT, listHardware } from '../../lib/api';
import { formatBytes, humanize, safeExternalUrl } from '../../lib/format';
import type { HardwareReference } from '../../lib/schemas';

function memoryLine(device: HardwareReference): string {
  const known = device.memory_bytes !== null || Boolean(device.vram_bytes);
  if (!known) return 'Memory not supplied';
  if (device.unified_memory === true) return `${formatBytes(device.memory_bytes)} unified memory (declared)`;
  const parts = [`System memory: ${formatBytes(device.memory_bytes)}`];
  if (device.vram_bytes) parts.push(`GPU memory: ${formatBytes(device.vram_bytes)}`);
  return `${parts.join(' · ')} (declared)`;
}

export async function HardwareCatalog() {
  let devices: HardwareReference[];
  try {
    devices = await listHardware();
  } catch (error) {
    return <ReferenceError error={error} what="Hardware" />;
  }

  if (devices.length === 0) return (
    <DiscoveryState>
      <EmptyState title="No hardware yet" description="Hardware will appear here as projects share their setups."
        action={<Link href="/projects" className={buttonClassName()}>Explore projects</Link>} />
    </DiscoveryState>
  );

  return (
    <div className="discovery-list stack gap-24">
      <p className="small muted" role="status">
        {devices.length >= REFERENCE_LIST_LIMIT
          ? `Showing the ${REFERENCE_LIST_LIMIT} most referenced devices; the list may be longer.`
          : `${devices.length} ${devices.length === 1 ? 'device' : 'devices'}`}
      </p>
      <ul className="row-list">
        {devices.map((device) => {
          const docs = safeExternalUrl(device.docs_url);
          return (
            <li key={device.hardware_descriptor_id}>
              <div className="row-main">
                <span className="row-title">{device.display_name ?? device.key}</span>
                <div className="meta-line">
                  <span className="mono">{device.key}</span>
                  <span>Platform: {device.platform ? humanize(device.platform) : 'Not supplied'}</span>
                  <span>Architecture: {device.cpu_architecture ?? 'Unknown'}</span>
                  <span>Accelerator: {device.accelerator ? humanize(device.accelerator) : 'Unknown'}</span>
                </div>
                <p className="small muted mt-6">
                  {memoryLine(device)}
                </p>
                {docs && (
                  <p className="small mt-6">
                    <a href={docs.href} target="_blank" rel="noopener noreferrer nofollow">
                      Documentation: {docs.host}
                      <span className="visually-hidden"> (opens in a new tab)</span>
                    </a>
                  </p>
                )}
              </div>
              <div className="row-side">
                <Link href={`/projects?hardware=${encodeURIComponent(device.key)}`}>
                  {device.project_count} {device.project_count === 1 ? 'project' : 'projects'}
                </Link>
                <span className="small muted">Referenced by current published versions</span>
              </div>
            </li>
          );
        })}
      </ul>
      <details className="reference-notes small muted">
        <summary>About this hardware information</summary>
        <p>Device details are declared by project authors, not measured. A listed device does not guarantee that every variant supports every project.</p>
      </details>
    </div>
  );
}
