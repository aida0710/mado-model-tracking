export type FormValues = Record<string, string | string[]>;

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
    | 'password'
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
  maxLength?: number;
  readOnly?: boolean;
}
