import type { ProjectVisibility } from '@mmt/contracts';
import { ProjectVisibilityLabel } from './ProjectVisibilityLabel';
import { text } from '../i18n/catalog';

const PROJECT_VISIBILITIES: readonly ProjectVisibility[] = ['public', 'private'];

const VISIBILITY_HINTS: Record<ProjectVisibility, string> = {
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
    <fieldset className="choice-picker">
      <legend>{text.projectVisibility}</legend>
      {PROJECT_VISIBILITIES.map((visibility) => (
        <label key={visibility} className="choice-picker-option">
          <input
            type="radio"
            name={name}
            value={visibility}
            checked={visibility === value}
            onChange={() => onChange(visibility)}
          />
          <span className="choice-picker-text">
            <ProjectVisibilityLabel visibility={visibility} />
            <span className="muted">{VISIBILITY_HINTS[visibility]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
