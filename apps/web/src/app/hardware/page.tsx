import type { Metadata } from 'next';
import { HardwareCatalog } from '../../features/references/HardwareCatalog';

export const metadata: Metadata = { title: 'Hardware' };
export const dynamic = 'force-dynamic';

export default function HardwarePage() {
  return <HardwareCatalog />;
}
