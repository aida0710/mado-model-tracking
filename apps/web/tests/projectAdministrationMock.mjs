// Projects for browser checks, following docs/api-contract.md: the list with visibility, creation
// with members, archiving, the admin list with archived Projects, restoring and purging, the user
// search behind member pickers, and the server directories offered for a filesystem root path.
import path from 'node:path';

// The mock API server's working directory; relative root paths resolve from here like the API's.
const SERVER_WORKING_DIRECTORY = '/srv/mmt';
const SERVER_DIRECTORIES = [
  '/data',
  '/data/.cache',
  '/data/datasets',
  '/srv',
  '/srv/mmt',
  '/srv/mmt/archive',
  '/srv/mmt/artifacts',
  '/srv/models',
  '/var',
  '/var/lib',
  '/var/lib/mmt',
  '/var/lib/mmt/artifacts',
];
const SERVER_FILES = ['/srv/mmt/README.md'];
// The API's cap on suggested directories (DIRECTORY_SUGGESTION_LIMIT).
const DIRECTORY_SUGGESTION_LIMIT = 50;
// Users the member pickers find besides the signed-in one.
const SEARCHABLE_USERS = [
  { id: '00000000-0000-4000-8000-00000000a001', email: 'aoki@example.invalid', displayName: '青木 研究員' },
  { id: '00000000-0000-4000-8000-00000000a002', email: 'ishii@example.invalid', displayName: '石井 研究員' },
  { id: '00000000-0000-4000-8000-00000000a003', email: 'ueda@example.invalid', displayName: '上田 研究員' },
];

function directoryStatus(resolvedPath) {
  if (SERVER_DIRECTORIES.includes(resolvedPath)) return 'directory';
  return SERVER_FILES.includes(resolvedPath) ? 'not_directory' : 'missing';
}

/** GET /admin/storage-directories?path=: the directories that complete `typed`. */
export function suggestDirectories(typed) {
  const resolvedPath = path.posix.resolve(SERVER_WORKING_DIRECTORY, typed);
  const listsChildren = typed.endsWith('/');
  const parent = listsChildren ? resolvedPath : path.posix.dirname(resolvedPath);
  const namePrefix = listsChildren ? '' : path.posix.basename(resolvedPath);
  const matches = SERVER_DIRECTORIES.filter((directory) => {
    if (directory === parent || path.posix.dirname(directory) !== parent) return false;
    const name = path.posix.basename(directory);
    return name.startsWith(namePrefix) && (!name.startsWith('.') || namePrefix.startsWith('.'));
  }).sort();
  return {
    resolvedPath,
    status: directoryStatus(resolvedPath),
    items: matches.slice(0, DIRECTORY_SUGGESTION_LIMIT),
    truncated: matches.length > DIRECTORY_SUGGESTION_LIMIT,
  };
}

const toProject = ({ archivedAt: _archivedAt, memberCount: _members, runCount: _runs, ...project }) =>
  project;
const toAdminProject = ({ role: _role, ...project }) => project;

/**
 * The Projects of a mock API. `mainProject` is the one the other mock routes serve; it stays the
 * same object, so PATCH and the other screens see each other's changes.
 */
export function createProjectAdministration({ id, now, user, mainProject }) {
  const state = {
    projects: [Object.assign(mainProject, { archivedAt: null, memberCount: 1, runCount: 3 })],
    createRequests: [],
    // Set to answer the next archive with 409 project_has_active_jobs.
    activeJobsBlockArchive: false,
  };
  const find = (projectId) => state.projects.find((project) => project.id === projectId);

  /** Answers the request when it is one of these routes; returns undefined otherwise. */
  function handle({ path: requestPath, method, url, body, reply, list, fulfillEmpty }) {
    if (requestPath === '/projects' && method === 'GET')
      return list(state.projects.filter((project) => !project.archivedAt).map(toProject));
    if (requestPath === '/projects' && method === 'POST') {
      state.createRequests.push(body);
      if (!body.name?.trim()) return reply({ error: 'name is required', code: 'validation' }, 400);
      const project = {
        id: id(),
        name: body.name,
        description: body.description ?? '',
        artifactBackend: body.artifactBackend ?? 'filesystem',
        visibility: body.visibility ?? 'public',
        role: 'admin',
        createdAt: now,
        archivedAt: null,
        memberCount: 1 + (body.members?.length ?? 0),
        runCount: 0,
      };
      state.projects.push(project);
      return reply(toProject(project), 201);
    }
    if (requestPath === '/users' && method === 'GET') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      return list(
        [user, ...SEARCHABLE_USERS].filter(
          (candidate) =>
            query &&
            (candidate.displayName.toLowerCase().includes(query) ||
              candidate.email.toLowerCase().startsWith(query)),
        ),
      );
    }
    if (requestPath === '/admin/storage-directories' && method === 'GET')
      return reply(suggestDirectories(url.searchParams.get('path') ?? ''));
    if (requestPath === '/admin/projects' && method === 'GET') {
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      return list(
        state.projects
          .filter((project) => includeArchived || !project.archivedAt)
          .map(toAdminProject),
      );
    }
    const projectMatch = requestPath.match(/^\/projects\/([^/]+)(\/archive)?$/);
    if (projectMatch && find(projectMatch[1])) {
      const project = find(projectMatch[1]);
      if (!projectMatch[2] && method === 'PATCH') {
        Object.assign(project, body);
        return reply(toProject(project));
      }
      if (projectMatch[2] && method === 'POST') {
        if (state.activeJobsBlockArchive) {
          state.activeJobsBlockArchive = false;
          return reply({ error: 'Project has active jobs', code: 'project_has_active_jobs' }, 409);
        }
        project.archivedAt = now;
        return fulfillEmpty();
      }
    }
    const adminMatch = requestPath.match(/^\/admin\/projects\/([^/]+)(\/restore)?$/);
    if (adminMatch && find(adminMatch[1])) {
      const project = find(adminMatch[1]);
      if (adminMatch[2] && method === 'POST') {
        project.archivedAt = null;
        return reply(toAdminProject(project));
      }
      if (!adminMatch[2] && method === 'DELETE') {
        if (!project.archivedAt)
          return reply({ error: 'Archive the Project first', code: 'project_not_archived' }, 409);
        state.projects = state.projects.filter((candidate) => candidate !== project);
        return fulfillEmpty();
      }
    }
    return undefined;
  }

  return { state, handle };
}
