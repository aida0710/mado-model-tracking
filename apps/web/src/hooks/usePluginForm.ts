import { useState } from 'react';
import type { PluginConnection } from '@mmt/contracts';
import type { FormValues } from '../types/form';
import { administrationApi } from '../api/administration';
import { getFieldValue } from '../lib/formValues';
import { MADO_PLUGIN_PRESET } from '../lib/pluginPreset';
import { useMutation } from './useMutation';

export function usePluginForm({ projectId, plugin }: { projectId: string; plugin?: PluginConnection }) {
  const [values, setValues] = useState<FormValues>({ name: plugin?.name ?? '', baseUrl: plugin?.baseUrl ?? '',
    tokenEnv: plugin?.tokenEnv ?? '', enabled: String(plugin?.enabled ?? true) });
  const mutation = useMutation();
  function changeValues(next: FormValues) { setValues(next); mutation.clearError(); }
  function save() {
    return mutation.run(() => {
      const input = { name: getFieldValue(values, 'name'), baseUrl: getFieldValue(values, 'baseUrl'),
        tokenEnv: getFieldValue(values, 'tokenEnv'), enabled: values.enabled === 'true' };
      return plugin ? administrationApi.updatePlugin(projectId, plugin.id, input) : administrationApi.createPlugin(projectId, input);
    });
  }
  return { ...mutation, values, changeValues, save,
    applyMadoPreset: () => changeValues({ ...values, ...MADO_PLUGIN_PRESET }) };
}
