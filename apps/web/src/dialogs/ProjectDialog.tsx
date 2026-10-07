import type { Project } from '@mmt/contracts';
import { administrationApi } from '../api/administration';
import { useQuery } from '../hooks/useQuery';
import { QueryDialog } from '../components/QueryDialog';
import { FormDialog } from '../components/FormDialog';
import { getFieldValue, getOptionalValue } from '../lib/formValues';
import { text } from '../i18n/catalog';

export function ProjectDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const backends = useQuery('storage-backends', administrationApi.backends);
  return (
    <QueryDialog title={text.newProject} onClose={onClose} query={backends}>
      {(items) => (
        <FormDialog
          title={text.newProject}
          onClose={onClose}
          onSaved={onSaved}
          submitLabel={text.create}
          fields={[
            { name: 'name', label: text.name, required: true },
            { name: 'description', label: text.description, type: 'textarea' },
            {
              name: 'artifactBackend',
              label: text.storage,
              type: 'select',
              defaultValue: items[0],
              options: items.map((backend) => ({ value: backend, label: text[backend] })),
              required: true,
            },
          ]}
          onSubmit={(values) =>
            administrationApi.createProject({
              name: getFieldValue(values, 'name'),
              description: getOptionalValue(values, 'description'),
              artifactBackend: getFieldValue(
                values,
                'artifactBackend',
              ) as Project['artifactBackend'],
            })
          }
        />
      )}
    </QueryDialog>
  );
}
