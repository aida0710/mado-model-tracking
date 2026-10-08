/**
 * Opens the Project creation dialog. Creation lives in the settings "Projects" section; a user
 * without any Project sees the same section on the start screen instead.
 */
export async function openProjectCreation(page, { base, projects }) {
  const [firstProject] = projects;
  await page.goto(firstProject ? `${base}/projects/${firstProject.id}/settings` : base);
  await page.getByRole('button', { name: 'プロジェクトを作成', exact: true }).click();
}
