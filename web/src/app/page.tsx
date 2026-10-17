import Link from 'next/link';
import { CatalogResults } from '../features/catalog/CatalogResults';
import { IntegrationGroup } from '../features/connect/IntegrationGroup';
import { SetupSection } from '../features/connect/SetupSection';
import { emptyQuery } from '../lib/catalog-query';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <div className="container stack home">
      <section aria-labelledby="hero" className="hero">
        <div>
          <h1 id="hero"><span className="hero-line">The home of</span> <span className="hero-line">local AI<span className="hero-period">.</span></span></h1>
          <p className="hero-subtitle">Projects, models, hardware, and working configurations. Connected by evidence.</p>
        </div>
        <div className="hero-description">
          <p>Discover local AI applications and workflows. Explore the models, hardware, and configurations behind them, inspect the evidence, and find the pieces that fit your setup.</p>
          <Link href="/projects">Explore projects <span aria-hidden="true">↗</span></Link>
        </div>
      </section>
      <div className="getting-started">
        <SetupSection />
        <IntegrationGroup />
      </div>
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
