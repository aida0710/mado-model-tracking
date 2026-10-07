import type { JsonObject } from '@mmt/contracts';
import { text } from '../i18n/catalog';

export type FormValues = Record<string, string | string[]>;
export const getFieldValue = (values: FormValues, name: string) =>
  typeof values[name] === 'string' ? (values[name] as string) : '';
export const getSelectedValues = (values: FormValues, name: string): string[] =>
  Array.isArray(values[name]) ? (values[name] as string[]) : [];
export const getOptionalValue = (values: FormValues, name: string) =>
  getFieldValue(values, name).trim() || undefined;
export const splitLines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value || '{}') as unknown;
  } catch {
    throw new Error(text.jsonError);
  }
}
export function parseJsonObject(value: string): JsonObject {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(text.jsonObjectError);
  return parsed as JsonObject;
}
export function parseStringMap(value: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  if (!Object.values(parsed).every((item) => typeof item === 'string'))
    throw new Error(text.stringMapError);
  return parsed as Record<string, string>;
}
export function parseStringArray(value: string): string[] {
  const parsed = parseJson(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === 'string') ||
    parsed.length === 0
  )
    throw new Error(text.stringArrayError);
  return parsed as string[];
}
export function parsePositiveInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(text.positiveNumberError);
  return number;
}
