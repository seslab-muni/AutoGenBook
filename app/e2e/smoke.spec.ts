import path from 'node:path';
import { expect, test } from '@playwright/test';

import { login } from './support/auth';

const FIXTURE_PDF = path.join(import.meta.dirname, 'fixtures/sample-source.pdf');

/**
 * Full-stack smoke test (issue #23): create project -> upload+attach a source -> author 2
 * chapters -> start a run -> wait for it to succeed -> a section shows generated content ->
 * build a PDF export -> download it. Runs against the real Docker Compose stack with the CLI
 * subprocess swapped for `tests/api/fake_cli.py` (see `playwright.config.ts`), so every step is
 * deterministic and fast, with no LLM key needed.
 */
test('project lifecycle: create, source, outline, run, export', async ({ page }) => {
  const projectTitle = `E2E Smoke ${Date.now()}`;

  await login(page);

  await page.getByRole('button', { name: 'New Project', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(projectTitle);
  await page.getByLabel('Subtitle').fill('End-to-end smoke fixture');
  await page.getByLabel('Topic').fill('Verifying the generation pipeline end to end.');
  await page.getByLabel('Authors').fill('E2E Suite');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  // The New Project dialog (mounted once at the root layout, so it survives this navigation)
  // plays a ~200ms close animation after `closeModal()`, during which its own embedded
  // `SourcePicker` still has an "Upload files" input in the DOM - opening Sources before that
  // finishes makes `getByLabel('Upload files')` match two inputs instead of one.
  await expect(page.getByRole('dialog')).toBeHidden();

  // --- Source upload + attach ---
  await page.getByRole('button', { name: /Sources/ }).click();
  await page.getByLabel('Upload files').setInputFiles(FIXTURE_PDF);
  await expect(page.getByText('Attached.')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole('heading', { name: 'sample-source.pdf' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // --- Author 2 chapters ---
  const chapterTitles = ['Chapter 1: Introduction', 'Chapter 2: Findings'];
  for (const title of chapterTitles) {
    await page.getByRole('button', { name: 'Add chapter' }).click();
    const titleField = page
      .getByRole('textbox', { name: /^Rename "Untitled chapter"/ })
      .last();
    await titleField.dblclick();
    const input = page.getByRole('textbox', { name: /^Rename "Untitled chapter"/ }).last();
    await input.fill(title);
    await input.press('Enter');
    // Not a generic `getByText(title)`: the newly-created chapter auto-selects, so its title
    // also renders as the editor pane's `<h1>` - scoping to the outline row's own rename span
    // (by its accessible name, which includes the now-renamed title) avoids a strict-mode
    // violation from matching both.
    await expect(page.getByRole('textbox', { name: `Rename "${title}"` })).toBeVisible();
  }

  // --- Start a run ---
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page).toHaveURL(/\/p\/[^/]+\/runs\/[^/]+$/);

  // --- Wait for it to succeed ---
  await expect(page.getByText('Succeeded', { exact: true })).toBeVisible({ timeout: 30_000 });

  // --- A section shows generated content ---
  await page.goto(page.url().replace(/\/runs\/.+$/, ''));
  await page.getByRole('textbox', { name: `Rename "${chapterTitles[0]}"` }).click();
  await expect(
    page.getByText(
      'This section is empty. Switch to Source to write it, or use the Copilot to generate it.',
    ),
  ).not.toBeVisible();
  await expect(page.getByText(/Fake generated content/)).toBeVisible();

  // --- Build a PDF export and download it ---
  await page.getByRole('button', { name: /Export/ }).click();
  const pdfCard = page.getByTestId('export-card-pdf');
  await pdfCard.getByRole('button', { name: 'Build PDF' }).click();
  const downloadLink = pdfCard.getByRole('link', { name: 'Download' });
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });

  // A plain `page.request.get(href)` doesn't carry the httpOnly session cookie the browser's own
  // click does (the API rejects it with 401) - triggering the real navigation and capturing
  // Playwright's `download` event is the meaningful "download it (expect 200)" check here: the
  // event only fires once the browser actually receives the file, not a 401/error response.
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(await download.failure()).toBeNull();
});
