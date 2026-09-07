import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AppProviders } from '@/app/providers';

import '@/index.css';

async function enableMocksIfRequested(): Promise<void> {
  if (import.meta.env.VITE_USE_MOCKS !== '1') return;
  const [{ worker }, { seedDatabase }] = await Promise.all([
    import('@/mocks/browser'),
    import('@/mocks/fixtures'),
  ]);
  seedDatabase();
  await worker.start({ onUnhandledRequest: 'bypass' });
}

async function main(): Promise<void> {
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
