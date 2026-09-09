import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Credentials for the account this suite logs in as. Seeded once against the running stack (not
 * by this suite - it has no way to run `api/scripts/users.py` itself) via:
 *
 *   docker compose -f docker-compose.yml -f docker-compose.ci.yml exec -T \
 *     -e AUTOGENBOOK_USER_PASSWORD="$E2E_USER_PASSWORD" api python -m api.scripts.users create \
 *     --email "$E2E_USER_EMAIL" --name "E2E User"
 *
 * before `pnpm e2e` runs (see `.github/workflows/web.yml`'s `e2e` job and `app/README.md`).
 */
export const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@example.com';
export const E2E_USER_PASSWORD = process.env.E2E_USER_PASSWORD ?? 'E2ePassw0rd!';

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_USER_EMAIL);
  await page.getByLabel('Password').fill(E2E_USER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');
}
