import type { ComputeTargetVisibility, ProjectVisibility } from '@mmt/contracts';
import { VisibilityLabel } from './VisibilityLabel';

type Visibility = ProjectVisibility | ComputeTargetVisibility;
const VISIBILITIES: readonly Visibility[] = ['public', 'private'];

/** Chooses Public or Private, with what each choice means (`hints`) under its name. */
export function VisibilityPicker({
  name,
  legend,
  hints,
  value,
  onChange,
}: {
  /** The radio group's name, unique in the form. */
  name: string;
  legend: string;
  hints: Record<Visibility, string>;
  value: Visibility;
  onChange: (visibility: Visibility) => void;
}) {
  return (
    <fieldset className="choice-picker">
      <legend>{legend}</legend>
      {VISIBILITIES.map((visibility) => (
        <label key={visibility} className="choice-picker-option">
          <input
            type="radio"
            name={name}
            value={visibility}
            checked={visibility === value}
            onChange={() => onChange(visibility)}
          />
          <span className="choice-picker-text">
            <VisibilityLabel visibility={visibility} />
            <span className="muted">{hints[visibility]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
