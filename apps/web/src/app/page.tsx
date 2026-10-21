import Link from 'next/link';
import { CopyBlock } from '../components/composites/CopyBlock';
import { Landing } from '../features/landing/Landing';
import { publicApiUrl } from '../lib/api';
import { readSetupState, sourceSetupClients } from '../lib/capabilities';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const setup = readSetupState();
  const command = setup.state === 'available' ? setup.command : sourceSetupClients(publicApiUrl())[0]!.command;
  return (
    <Landing>
      <div className="landing-brand">
        <h1 id="landing-title" className="landing-wordmark">localfirst</h1>
        <p className="landing-eyebrow">Your tools · Your projects · Your machine</p>
      </div>
      <div className="landing-copy">
        <p className="landing-lede">The home of local AI.</p>
        <p className="landing-body">Bring a project. Connect your tools. Build with AI on your own machine.</p>
        <div className="landing-command">
          <CopyBlock text={command} note={setup.state === 'available'
            ? 'Run in your terminal to connect your agent. Requires Node.js 22+.'
            : 'Run from a built repository checkout. Requires Node.js 22+.'} />
        </div>
        <nav className="landing-links" aria-label="Get started">
          <Link href="/docs/connect">Get started <span aria-hidden="true">↗</span></Link>
          <Link href="/docs">Read the docs</Link>
        </nav>
      </div>
    </Landing>
  );
}
