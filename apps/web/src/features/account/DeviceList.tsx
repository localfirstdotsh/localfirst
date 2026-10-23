'use client';
import { useId, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { ConfirmationSection } from '../../components/composites/ConfirmationSection';
import type { DevicesData } from '../../lib/browser-schemas';

type Device = DevicesData['devices'][number];

function DeviceRow({ device, disabled, onRevoke }: { device: Device; disabled: boolean; onRevoke: () => void }) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <li className="device-row">
      <div className="device-main">
        <h3 className="row-heading">{device.label}</h3>
        <dl className="device-facts small">
          <div><dt className="muted">Linked</dt><dd>{device.created_at.slice(0, 10)}</dd></div>
          <div><dt className="muted">Expires</dt><dd>{device.expires_at.slice(0, 10)}</dd></div>
          <div><dt className="muted">Last used</dt><dd>{device.last_used_at ? `${device.last_used_at.slice(0, 16).replace('T', ' ')} UTC` : 'Never used'}</dd></div>
        </dl>
        <Button ref={trigger} size="small" className="button-quiet-danger device-revoke" aria-expanded={confirming} aria-controls={`${id}-revoke`} aria-label={`Revoke ${device.label}`} disabled={disabled} onClick={() => setConfirming(true)}>Revoke</Button>
      </div>
      {confirming && <ConfirmationSection id={`${id}-revoke`} level="h3" tone="danger" title={`Revoke ${device.label}?`}
        actions={<>
          <Button className="button-danger" disabled={disabled} onClick={onRevoke}>Confirm revocation</Button>
          <Button disabled={disabled} onClick={() => { setConfirming(false); trigger.current?.focus(); }}>Cancel</Button>
        </>}>
        <p className="small">This machine will stop being able to record your decisions. Approvals it already recorded stay valid until they expire or are used.</p>
      </ConfirmationSection>}
    </li>
  );
}

/** Linked machines with the facts that matter for trusting them, and revocation behind a confirmation. */
export function DeviceList({ devices, disabled, onRevoke }: { devices: readonly Device[]; disabled: boolean; onRevoke: (device: Device) => void }) {
  return <ul className="list-group">{devices.map((device) => <DeviceRow key={device.device_id} device={device} disabled={disabled} onRevoke={() => onRevoke(device)} />)}</ul>;
}
