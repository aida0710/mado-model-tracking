import { useId } from 'react';
import type { FormField, FormValues } from '../types/form';
import { getFieldValue, getSelectedValues } from '../lib/formValues';
import { SuggestionInput } from './SuggestionInput';

export function FormFields({
  fields,
  values,
  onChange,
}: {
  fields: FormField[];
  values: FormValues;
  onChange: (values: FormValues) => void;
}) {
  const idPrefix = useId();
  return (
    <div className="form-fields">
      {fields
        .filter((field) => !field.visible || field.visible(values))
        .map((field) => {
          const id = `${idPrefix}-${field.name}`;
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
                  maxLength={field.maxLength}
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
              ) : field.suggest ? (
                <SuggestionInput
                  id={id}
                  value={value}
                  onChange={change}
                  suggest={field.suggest}
                  required={field.required}
                  readOnly={field.readOnly}
                  placeholder={field.placeholder}
                  maxLength={field.maxLength}
                />
              ) : (
                <input
                  id={id}
                  type={field.type ?? 'text'}
                  value={value}
                  required={field.required}
                  readOnly={field.readOnly}
                  // Keeps the browser from filling a saved login password into a secret field.
                  autoComplete={field.type === 'password' ? 'new-password' : undefined}
                  min={field.min}
                  max={field.max}
                  maxLength={field.maxLength}
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
