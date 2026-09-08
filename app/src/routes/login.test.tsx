import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { MOCK_USER, MOCK_USER_PASSWORD } from '@/mocks/fixtures';
import { problemResponse } from '@/mocks/problem';
import { server } from '@/mocks/server';
import { renderRouterApp } from '@/test/router-test-utils';

/** MSW defaults to "signed in"; route-level tests that need the logged-out form override this. */
function simulateLoggedOut(): void {
  server.use(
    http.get('*/api/v1/auth/me', () => problemResponse(401, 'Not authenticated', '/api/v1/auth/me')),
  );
}

describe('/login', () => {
  it('redirects away to / when a session already exists', async () => {
    renderRouterApp('/login');

    expect(
      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i }),
    ).toBeInTheDocument();
  });

  it('redirects to a valid ?redirect= target when a session already exists', async () => {
    renderRouterApp('/login?redirect=%2Fp%2Fbook-consensus-quantum-2026');

    expect(
      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault Tolerance/i }),
    ).toBeInTheDocument();
  });

  it('shows the sign-in form when there is no session', async () => {
    simulateLoggedOut();
    renderRouterApp('/login');

    expect(
      await screen.findByText('Sign in to your AutoGenBook Studio account.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('shows an inline error on invalid credentials and keeps the form enabled', async () => {
    simulateLoggedOut();
    const user = userEvent.setup();
    renderRouterApp('/login');

    await user.type(await screen.findByLabelText('Email'), MOCK_USER.email);
    await user.type(screen.getByLabelText('Password'), 'the-wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // `selector: 'span'` disambiguates the inline form error from the identical global toast
    // (`createQueryClient`'s `MutationCache.onError`) that also fires for this failed mutation.
    expect(
      await screen.findByText(/Invalid email or password/i, { selector: 'span' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled();
  });

  it('signs in and navigates to / when there is no redirect target', async () => {
    simulateLoggedOut();
    const user = userEvent.setup();
    renderRouterApp('/login');

    await user.type(await screen.findByLabelText('Email'), MOCK_USER.email);
    await user.type(screen.getByLabelText('Password'), MOCK_USER_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i }),
    ).toBeInTheDocument();
  });

  it('signs in and navigates to a valid ?redirect= target', async () => {
    simulateLoggedOut();
    const user = userEvent.setup();
    renderRouterApp('/login?redirect=%2Fp%2Fbook-consensus-quantum-2026');

    await user.type(await screen.findByLabelText('Email'), MOCK_USER.email);
    await user.type(screen.getByLabelText('Password'), MOCK_USER_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText(/Foundations of Classical Asynchronous Consensus/i),
    ).toBeInTheDocument();
  });

  it('ignores an unsafe ?redirect= target (protocol-relative) and navigates to / instead', async () => {
    simulateLoggedOut();
    const user = userEvent.setup();
    renderRouterApp('/login?redirect=%2F%2Fevil.example.com');

    await user.type(await screen.findByLabelText('Email'), MOCK_USER.email);
    await user.type(screen.getByLabelText('Password'), MOCK_USER_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(window.location.hostname).not.toBe('evil.example.com'));
    expect(
      await screen.findByRole('heading', { name: /Distributed Consensus & Quantum Fault/i }),
    ).toBeInTheDocument();
  });

  it('disables the form while the login request is pending', async () => {
    simulateLoggedOut();
    server.use(
      http.post('*/api/v1/auth/login', async () => {
        await delay(150);
        return HttpResponse.json(MOCK_USER);
      }),
    );
    const user = userEvent.setup();
    renderRouterApp('/login');

    await user.type(await screen.findByLabelText('Email'), MOCK_USER.email);
    await user.type(screen.getByLabelText('Password'), MOCK_USER_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('button', { name: /Signing in/i })).toBeDisabled();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
  });
});
