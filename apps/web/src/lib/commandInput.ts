import { text } from '../i18n/catalog';

// Keep both normal and test commands within the API's argv bounds.
const MAX_COMMAND_ARGUMENTS = 100;
const MAX_COMMAND_ARGUMENT_LENGTH = 4000;

export function parseCommand(value: string, { optional = false }: { optional?: boolean } = {}): string[] {
  if (!value.trim() && optional) return [];
  let argumentsValue: unknown;
  try { argumentsValue = JSON.parse(value); }
  catch { throw new Error(text.jsonError); }
  if (!Array.isArray(argumentsValue) || !argumentsValue.every((argument) => typeof argument === 'string'))
    throw new Error(text.stringArrayError);
  const command = argumentsValue as string[];
  if (!command.length && optional) return [];
  if (!command[0]?.trim() || command.some((argument) => !argument.length || argument.includes('\0')))
    throw new Error(text.emptyCommandError);
  if (command.length > MAX_COMMAND_ARGUMENTS || command.some((argument) => argument.length > MAX_COMMAND_ARGUMENT_LENGTH))
    throw new Error(text.commandSizeError);
  return command;
}
