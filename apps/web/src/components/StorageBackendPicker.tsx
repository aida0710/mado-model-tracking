import type { StorageBackendChoice } from '../hooks/useStorageBackends';
import { text } from '../i18n/catalog';

/**
 * Picks a Project's storage backend from a list showing each name, kind and the default.
 * A current value missing from the choices (for example a disabled backend) stays listed so
 * saving other settings does not silently move the Project.
 */
export function StorageBackendPicker({
  name,
  choices,
  defaultBackend,
  value,
  onChange,
}: {
  name: string;
  choices: StorageBackendChoice[];
  defaultBackend: string;
  value: string;
  onChange: (backend: string) => void;
}) {
  const listed =
    choices.some((choice) => choice.name === value) || !value
      ? choices
      : [...choices, { name: value }];
  return (
    <fieldset className="storage-picker">
      <legend>{text.storage}</legend>
      {listed.map((choice) => (
        <label key={choice.name} className="storage-picker-option">
          <input
            type="radio"
            name={name}
            value={choice.name}
            checked={choice.name === value}
            onChange={() => onChange(choice.name)}
          />
          <span className="storage-picker-name">{choice.name}</span>
          {choice.kind && <span className="storage-tag">{text[choice.kind]}</span>}
          {choice.name === defaultBackend && (
            <span className="storage-tag storage-default">{text.storageDefault}</span>
          )}
        </label>
      ))}
    </fieldset>
  );
}
