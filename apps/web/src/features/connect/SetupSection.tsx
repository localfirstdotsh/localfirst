import Link from 'next/link';
import { publicApiUrl } from '../../lib/api';
import { readSetupState, sourceSetupClients } from '../../lib/capabilities';
import { CommandBlock } from '../../components/composites/CommandBlock';

/** Released deployments use their configured CLI; source builds remain usable before npm publication. */
export function SetupSection() {
  const setup = readSetupState();
  const clients = setup.state === 'available' ? setup.clients : sourceSetupClients(publicApiUrl());
  const command = setup.state === 'available' ? setup.command : clients[0]!.command;
  return (
    <section className="setup-section" aria-labelledby="get-started">
      <h2 className="eyebrow" id="get-started">GET STARTED</h2>
      <CommandBlock command={command} clients={clients} note={setup.state === 'available'
        ? 'Run in your terminal, review the registration, then sign in through your client. Requires Node.js 22+.'
        : 'From a built repository checkout. Requires Node.js 22+ and your installed AI client. Review registration, then sign in.'} />
      <Link className="setup-guide" href="/docs/connect#setup">{setup.state === 'available' ? 'Setup instructions' : 'Build the CLI & connect your agent'} →</Link>
    </section>
  );
}
