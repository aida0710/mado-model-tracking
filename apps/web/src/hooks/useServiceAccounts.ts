import type {
  ServiceAccountCreate,
  ServiceAccountTokenCreate,
  ServiceAccountUpdate,
} from '@mmt/contracts';
import { accessApi } from '../api/access';
import { useQuery } from './useQuery';

/**
 * Service Accounts of a Project and the Project token list that shows their tokens. Both are
 * Project admin views, so nothing is requested when `isProjectAdmin` is false.
 */
export function useServiceAccounts(projectId: string, isProjectAdmin: boolean) {
  const serviceAccounts = useQuery(
    isProjectAdmin ? `${projectId}:service-accounts` : null,
    (signal) => accessApi.serviceAccounts(projectId, signal),
  );
  const projectTokens = useQuery(isProjectAdmin ? `${projectId}:project-tokens` : null, (signal) =>
    accessApi.projectTokens(projectId, signal),
  );
  return {
    serviceAccounts,
    projectTokens,
    createServiceAccount: (body: ServiceAccountCreate) =>
      accessApi.createServiceAccount(projectId, body),
    updateServiceAccount: (serviceAccountId: string, body: ServiceAccountUpdate) =>
      accessApi.updateServiceAccount(projectId, serviceAccountId, body),
    issueServiceAccountToken: (serviceAccountId: string, body: ServiceAccountTokenCreate) =>
      accessApi.createServiceAccountToken(projectId, serviceAccountId, body),
  };
}

export type ServiceAccountsState = ReturnType<typeof useServiceAccounts>;
