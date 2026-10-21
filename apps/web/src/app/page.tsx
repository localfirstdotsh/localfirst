import Link from 'next/link';
import { IntegrationGroup } from '../features/connect/IntegrationGroup';
import { CopyBlock } from '../components/composites/CopyBlock';
import { publicApiUrl } from '../lib/api';
import { readSetupState, sourceSetupClients } from '../lib/capabilities';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const setup = readSetupState();
  const command = setup.state === 'available' ? setup.command : sourceSetupClients(publicApiUrl())[0]!.command;
  return (
    <div className="container stack home">
      <section aria-labelledby="hero" className="hero">
        <h1 id="hero">The home of local AI<span className="hero-period">.</span></h1>
        <p className="hero-subtitle">Build, test, and share AI projects that run on hardware you own. Connect your agent to project specs, model requirements, and setup instructions.</p>
        <div className="hero-cli"><CopyBlock text={command} note={setup.state === 'available'
          ? 'Run in your terminal to connect your agent. Requires Node.js 22+.'
          : 'Run from a built repository checkout. Requires Node.js 22+.'} /></div>
        <div className="hero-links">
          <Link href="/docs/connect">Connect your agent →</Link>
          <Link href="/docs">Read the docs</Link>
        </div>
        <IntegrationGroup compact />
        <p className="hero-access">Open to everyone. Sign in with GitHub when you contribute.</p>
      </section>
    </div>
  );
}
