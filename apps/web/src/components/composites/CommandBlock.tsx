'use client';

import { useState } from 'react';
import { CopyBlock } from './CopyBlock';

/** A client selector around the shared exact-copy control. */
export function CommandBlock({ command, clients, note }: { command: string; clients: readonly { id: string; label: string; command: string }[]; note?: string }) {
  const [selected, setSelected] = useState(clients[0]?.id ?? null);
  const text = clients.find((client) => client.id === selected)?.command ?? command;
  return (
    <div>
      {clients.length > 0 && <div className="client-row" role="group" aria-label="Agent client">
        <span className="visually-hidden">Connect your agent</span>
        {clients.map((client) => <button key={client.id} type="button" className="chip" aria-pressed={selected === client.id} onClick={() => setSelected(client.id)}>{client.label}</button>)}
      </div>}
      <CopyBlock key={text} text={text} note={note ?? 'Run it in your terminal, sign in if asked, then review permissions. This registers access and installs no project code or model weights.'} />
    </div>
  );
}
