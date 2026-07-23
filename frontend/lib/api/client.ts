import { chainApiClient } from '@/lib/chain/client';
import { mockApiClient } from '@/lib/mock/client';

// Live Arc is the default. The explicit flag is retained only as a local visual-development
// escape hatch; production builds and unconfigured development sessions read the chain.
export const apiClient =
  process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true'
    ? mockApiClient
    : chainApiClient;
