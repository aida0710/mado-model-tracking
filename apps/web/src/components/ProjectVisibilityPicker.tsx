import type { ProjectVisibility } from '@mmt/contracts';
import { VisibilityPicker } from './VisibilityPicker';
import { text } from '../i18n/catalog';

const PROJECT_VISIBILITY_HINTS: Record<ProjectVisibility, string> = {
  public: text.projectVisibilityPublicHint,
  private: text.projectVisibilityPrivateHint,
};

/** Chooses who may open a Project, with what each choice means under its name. */
export function ProjectVisibilityPicker({
  name,
  value,
  onChange,
}: {
  name: string;
  value: ProjectVisibility;
  onChange: (visibility: ProjectVisibility) => void;
}) {
  return (
    <VisibilityPicker
      name={name}
      legend={text.projectVisibility}
      hints={PROJECT_VISIBILITY_HINTS}
      value={value}
      onChange={onChange}
    />
  );
}
