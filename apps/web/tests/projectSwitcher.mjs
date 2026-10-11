// The Project switcher at the top of the sidebar, or in the project bar on narrower screens.

/** The button that shows the open Project and opens the switcher. */
export const projectSwitcherButton = (page) =>
  page.getByRole('button', { name: /^プロジェクト\s/ }).and(page.locator('[aria-haspopup="listbox"]'));

/** Opens the switcher and returns its list of Projects. */
export async function openProjectSwitcher(page) {
  await projectSwitcherButton(page).click();
  const listbox = page.getByRole('listbox', { name: 'プロジェクト', exact: true });
  await listbox.waitFor();
  return listbox;
}

/** Opens another Project from the switcher by its name. */
export async function switchProject(page, name) {
  const listbox = await openProjectSwitcher(page);
  await listbox.getByRole('option').filter({ hasText: name }).first().click();
}
