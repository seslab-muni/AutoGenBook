import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppProviders } from '@/app/providers';
import { installStaleBuildRecovery } from '@/lib/stale-build';

import '@/index.css';

async function enableMocksIfRequested(): Promise<void> {
  if (import.meta.env.VITE_USE_MOCKS !== '1') return;
  const [
    { worker },
    { seedDatabase, seedReviewDemo },
    { mockRevisionConfig, db },
    { queryClient },
  ] = await Promise.all([
    import('@/mocks/browser'),
    import('@/mocks/fixtures'),
    import('@/mocks/db'),
    import('@/app/query-client'),
  ]);
  seedDatabase();
  seedReviewDemo();
  // Lets a browser check slow the mock accept and save down (`window.__mockConfig.acceptDelayMs = 2000`), or make node reads answer late (`nodeGetDelayMs`).
  (window as unknown as { __mockConfig?: unknown }).__mockConfig = mockRevisionConfig;
  // Same for a browser check that needs to put content in the mock database (a large section, many comments) and have the app read it again.
  (window as unknown as { __mockDb?: unknown; __queryClient?: unknown }).__mockDb = db;
  (window as unknown as { __queryClient?: unknown }).__queryClient = queryClient;
  await worker.start({ onUnhandledRequest: 'bypass' });
}

async function main(): Promise<void> {
  installStaleBuildRecovery();
  await enableMocksIfRequested();

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element #root not found');
  }

  createRoot(rootElement).render(
    <StrictMode>
      <AppProviders />
    </StrictMode>,
  );
}

void main();
