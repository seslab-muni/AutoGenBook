import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { login } from './support/auth';

/**
 * Accessibility smoke (issue #23): `axe-core` over the login screen, the projects hub, the
 * studio, and every dialog reachable from the studio header. Fails on any serious/critical
 * violation - moderate/minor findings are still reported (the full result is logged) but don't
 * fail the run, since axe's heuristics flag some cosmetic-only issues on shadcn/ui's generated
 * primitives that aren't worth gating CI on.
 */
async function expectNoSeriousViolations(
  page: import('@playwright/test').Page,
  label: string,
  { inDialog = false }: { inDialog?: boolean } = {},
) {
  const builder = new AxeBuilder({ page });
  if (inDialog) {
    // axe-core's own docs list `color-contrast` as unreliable for elements positioned with CSS
    // `transform` - every shadcn/ui `DialogContent` is centered via `translate-x-[-50%]
    // translate-y-[-50%]`, which reliably makes axe report a nonsensical blended background
    // (verified against real screenshots of these dialogs, which render at full contrast; the
    // reported color also isn't stable across nodes/runs, consistent with a failed background
    // computation rather than a real rendered color). Structural checks (labels, roles, nesting,
    // ...) stay fully active in dialogs - only this one rule is unreliable under `transform`.
    builder.disableRules(['color-contrast']);
  }
  const results = await builder.analyze();
  const serious = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  if (serious.length > 0) {
    console.log(`axe violations on ${label}:`, JSON.stringify(serious, null, 2));
  }
  expect(serious, `${label} has serious/critical axe violations`).toEqual([]);
}

test.describe('accessibility', () => {
  test('login screen', async ({ page }) => {
    await page.goto('/login');
    await expectNoSeriousViolations(page, 'login');
  });

  test('projects hub', async ({ page }) => {
    await login(page);
    await expectNoSeriousViolations(page, 'projects hub');
  });

  test('studio and its dialogs', async ({ page }) => {
    await login(page);

    const projectTitle = `E2E A11y ${Date.now()}`;
    await page.getByRole('button', { name: 'New Project', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill(projectTitle);
    await page.getByLabel('Subtitle').fill('Accessibility fixture');
    await page.getByLabel('Topic').fill('Verifying dialog accessibility.');
    await page.getByLabel('Authors').fill('E2E Suite');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/p\/[^/]+$/);
    // The New Project dialog (mounted once at the root layout, so it survives this navigation)
    // plays a ~200ms close animation after `closeModal()` - scanning before it fully unmounts
    // would flag its fading-out content's transient near-zero contrast as a false positive.
    await expect(page.getByRole('dialog')).toBeHidden();
    await expectNoSeriousViolations(page, 'studio');

    const dialogs: Array<{ label: string; open: () => Promise<void> }> = [
      { label: 'Sources dialog', open: () => page.getByRole('button', { name: /Sources/ }).click() },
      { label: 'Export dialog', open: () => page.getByRole('button', { name: /Export/ }).click() },
      {
        label: 'Project settings dialog',
        open: () => page.getByRole('button', { name: /Settings/ }).click(),
      },
    ];

    for (const dialog of dialogs) {
      await dialog.open();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoSeriousViolations(page, dialog.label, { inDialog: true });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
    }

    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoSeriousViolations(page, 'Start run dialog', { inDialog: true });
  });
});
