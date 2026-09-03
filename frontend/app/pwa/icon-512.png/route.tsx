import { createPredexAppIcon } from '@/lib/pwa/app-icon';

export const dynamic = 'force-static';

export function GET() {
  return createPredexAppIcon(512);
}
