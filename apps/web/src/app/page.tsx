import Link from 'next/link';
import { CatalogResults } from '../features/catalog/CatalogResults';
import { IntegrationGroup } from '../features/connect/IntegrationGroup';
import { CopyBlock } from '../components/composites/CopyBlock';
import { emptyQuery } from '../lib/catalog-query';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <div className="container stack home">
      <section aria-labelledby="hero" className="hero">
        <h1 id="hero">The home of local AI<span className="hero-period">.</span></h1>
        <p className="hero-subtitle">Discover, run, and build with local AI. Explore real projects, reusable workflows, models, and hardware. Connect through your favorite AI tools.</p>
        <div className="hero-cli"><CopyBlock text="npx localfirstdotsh" note="Run in your terminal. Requires Node.js 22+." /></div>
        <IntegrationGroup compact />
      </section>
      <section aria-labelledby="catalog" className="stack gap-16">
        <div className="spread">
          <div><h2 id="catalog">Projects</h2><p className="section-intro">Discover local AI applications, workflows, and builds.</p></div>
          <Link href="/projects" className="small">View all projects →</Link>
        </div>
        <CatalogResults query={emptyQuery()} preview />
      </section>
    </div>
  );
}
