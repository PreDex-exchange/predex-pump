import { mockApiClient } from '@/lib/mock/client';

import { backendRestClient } from './rest-client';

// The indexed backend is the display source. Mock data remains an explicit
// visual-development escape hatch; transaction-critical hooks never use this client.
export const apiClient =
  process.env.NEXT_PUBLIC_USE_MOCK_DATA === 'true'
    ? mockApiClient
    : backendRestClient;
