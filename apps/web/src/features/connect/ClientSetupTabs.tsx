'use client';

import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';

type ClientPanel = { id: string; label: string; icon?: string; content: ReactNode };

export function ClientSetupTabs({ clients }: { clients: readonly ClientPanel[] }) {
  const [selected, setSelected] = useState(clients[0]!.id);
  const [enhanced, setEnhanced] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    let frame = 0;
    const syncHash = () => {
      const id = window.location.hash.slice(1);
      const client = clients.find((item) => item.id === id);
      if (!client) return;
      setSelected(client.id);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.current?.scrollIntoView({ block: 'start' });
        buttons.current.get(client.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    };
    setEnhanced(true);
    syncHash();
    window.addEventListener('hashchange', syncHash);
    window.addEventListener('popstate', syncHash);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', syncHash);
      window.removeEventListener('popstate', syncHash);
    };
  }, [clients]);

  function select(id: string) {
    setSelected(id);
    window.history.replaceState(window.history.state, '', `#${id}`);
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % clients.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + clients.length) % clients.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = clients.length - 1;
    else return;
    event.preventDefault();
    const id = clients[next]!.id;
    select(id);
    buttons.current.get(id)?.focus({ preventScroll: true });
    buttons.current.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  return <div ref={root} className="client-setup" data-enhanced={enhanced}>
    <div className="client-tabs" role="tablist" aria-label="AI client">
      {clients.map((client, index) => <button key={client.id} ref={(node) => { if (node) buttons.current.set(client.id, node); else buttons.current.delete(client.id); }}
        id={`tab-${client.id}`} className="client-tab" type="button" role="tab"
        aria-selected={selected === client.id} aria-controls={client.id} tabIndex={selected === client.id ? 0 : -1}
        onClick={() => select(client.id)} onKeyDown={(event) => navigate(event, index)}>
        {/* Local vendor marks identify the client without changing the accessible label. */}
        {client.icon && <img src={`/integrations/${client.icon}.svg`} width="18" height="18" alt="" />}
        {client.label}
      </button>)}
    </div>
    {clients.map((client) => <section key={client.id} id={client.id} className="client-panel stack gap-16"
      role={enhanced ? 'tabpanel' : undefined} aria-labelledby={enhanced ? `tab-${client.id}` : `heading-${client.id}`}
      tabIndex={enhanced ? 0 : undefined} hidden={enhanced && selected !== client.id}>
      <h3 id={`heading-${client.id}`}>{client.label}</h3>
      {client.content}
    </section>)}
  </div>;
}
