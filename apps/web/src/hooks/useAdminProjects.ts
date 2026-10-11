import { useState } from 'react';
import { adminProjectsApi } from '../api/adminProjects';
import { useQuery } from './useQuery';

/** The admin Project list, and whether it also shows archived Projects. */
export function useAdminProjects() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const projects = useQuery(`admin-projects:${includeArchived}`, (signal) =>
    adminProjectsApi.list({ includeArchived }, signal),
  );
  return { projects, includeArchived, setIncludeArchived };
}
