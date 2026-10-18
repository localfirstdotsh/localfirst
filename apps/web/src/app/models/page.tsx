import type { Metadata } from 'next';
import { ModelsCatalog } from '../../features/references/ModelsCatalog';

export const metadata: Metadata = { title: 'Models' };
export const dynamic = 'force-dynamic';

export default function ModelsPage() {
  return <ModelsCatalog />;
}
