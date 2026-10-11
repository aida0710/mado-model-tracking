import { openProjectSwitcher } from './projectSwitcher.mjs';

/**
 * Opens the Project creation dialog: from the last entry of the Project switcher, or, for a user
 * without any Project, from the button on the start screen.
 */
export async function openProjectCreation(page, { base, projects }) {
  const [firstProject] = projects;
  if (!firstProject) {
    await page.goto(base);
    await page.getByRole('button', { name: 'プロジェクトを作成', exact: true }).click();
    return;
  }
  await page.goto(`${base}/projects/${firstProject.id}/experiments`);
  const listbox = await openProjectSwitcher(page);
  await listbox.getByRole('option', { name: 'プロジェクトを作成', exact: true }).click();
}
