import { matchConnectionByUrl } from './git-connections.mjs';
import { cloneUrlForProject, getGitlabProject } from './gitlab-api.mjs';

export function gitFailureBody(err) {
  const failure = { error: err?.message || 'git clone failed' };
  if (err?.gitCode) failure.code = err.gitCode;
  if (err?.gitCode === 'unknown' && err.detail) failure.detail = String(err.detail).slice(0, 800);
  if (err?.via) failure.via = err.via;
  return failure;
}

export function connectionCloneError(code, via = 'connection') {
  const err = new Error(code === 'http_not_allowed' ? 'http not allowed' : 'git clone failed');
  err.status = 400;
  err.gitCode = code || 'unknown';
  err.via = via;
  return err;
}

export function usesConnectionClone(connection, gitUrl) {
  if (!connection || !/^https?:\/\//i.test(gitUrl)) return false;
  if (connection.token) return true;
  if (connection.caFile) return true;
  return /^http:\/\//i.test(gitUrl);
}

export function wantsGitImport(body) {
  if (!body || typeof body !== 'object') return false;
  return Boolean(body.gitUrl) || Boolean(body.connectionId) || (body.projectId != null && String(body.projectId).trim() !== '');
}

/**
 * Resolve gitUrl / branch / connection for a new workspace.
 * `loadConnections` must return the stored (unmasked) connection list.
 */
export async function planWorkspaceGit(body, { loadConnections }) {
  const connections = await loadConnections();
  let connection = null;
  if (body.connectionId) {
    connection = connections.find((item) => item.id === String(body.connectionId)) || null;
    if (!connection) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
  }
  let gitUrl = String(body.gitUrl || '').trim();
  let branch = body.branch || '';
  const projectId = body.projectId != null ? String(body.projectId).trim() : '';
  if (projectId) {
    if (!connection) {
      const err = new Error('connection required');
      err.status = 400;
      throw err;
    }
    const found = await getGitlabProject(connection, projectId);
    if (!found.ok) throw connectionCloneError(found.code || 'unknown');
    try {
      gitUrl = cloneUrlForProject(connection, found.project);
    } catch (err) {
      if (!err.via) err.via = 'connection';
      throw err;
    }
    if (!branch) branch = found.project.defaultBranch || '';
  } else if (!connection && gitUrl) {
    connection = matchConnectionByUrl(connections, gitUrl);
  }
  if (!gitUrl) {
    const err = new Error('invalid gitUrl');
    err.status = 400;
    throw err;
  }
  return { connection, gitUrl, branch };
}
