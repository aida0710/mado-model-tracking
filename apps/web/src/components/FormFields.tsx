import type { FormValues } from '../lib/formValues';
import { getFieldValue, getSelectedValues } from '../lib/formValues';

export interface SelectOption {
  value: string;
  label: string;
}
export interface FormField {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'email'
    | 'url'
    | 'number'
    | 'textarea'
    | 'select'
    | 'multiselect'
    | 'datetime-local'
    | 'checkbox';
  required?: boolean;
  defaultValue?: string | string[];
  options?: SelectOption[];
  placeholder?: string;
  visible?: (values: FormValues) => boolean;
  min?: number;
  max?: number;
  readOnly?: boolean;
}
export function createInitialValues(fields: FormField[]): FormValues {
  return Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.defaultValue ?? (field.type === 'multiselect' ? [] : ''),
    ]),
  );
}

export function FormFields({
  fields,
  values,
  onChange,
}: {
  fields: FormField[];
  values: FormValues;
  onChange: (values: FormValues) => void;
}) {
  return (
    <div className="form-fields">
      {fields
        .filter((field) => !field.visible || field.visible(values))
        .map((field) => {
          const id = `field-${field.name}`;
          const value = getFieldValue(values, field.name);
          const change = (next: string | string[]) => onChange({ ...values, [field.name]: next });
          if (field.type === 'checkbox')
            return (
              <label className="checkbox-field" key={field.name}>
                <input
                  type="checkbox"
                  checked={value === 'true'}
                  onChange={(event) => change(String(event.target.checked))}
                />
                {field.label}
              </label>
            );
          return (
            <div className="field" key={field.name}>
              <label htmlFor={id}>
                {field.label}
                {field.required && (
                  <span className="required" aria-hidden="true">
                    {' '}
                    *
                  </span>
                )}
              </label>
              {field.type === 'textarea' ? (
                <textarea
                  id={id}
                  value={value}
                  rows={4}
                  required={field.required}
                  placeholder={field.placeholder}
                  onChange={(event) => change(event.target.value)}
                />
              ) : field.type === 'select' || field.type === 'multiselect' ? (
                <select
                  id={id}
                  multiple={field.type === 'multiselect'}
                  value={
                    field.type === 'multiselect' ? getSelectedValues(values, field.name) : value
                  }
                  required={field.required}
                  onChange={(event) =>
                    change(
                      field.type === 'multiselect'
                        ? Array.from(event.target.selectedOptions, (option) => option.value)
                        : event.target.value,
                    )
                  }
                >
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type={field.type ?? 'text'}
                  value={value}
                  required={field.required}
                  readOnly={field.readOnly}
                  min={field.min}
                  max={field.max}
                  placeholder={field.placeholder}
                  onChange={(event) => change(event.target.value)}
                />
              )}
            </div>
          );
        })}
    </div>
  );
}
