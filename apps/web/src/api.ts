import {
  SKALI_HEADER,
  SKALI_HEADER_VALUE,
  type AdoptRequest,
  type ConfigFileView,
  type ConfigFormat,
  type ConfigHistoryEntry,
  type ConfigSaveRequest,
  type ConfigSaveResult,
  type ConfigSourceView,
  type DeployLogChunk,
  type DeployStatusView,
  type FsListing,
  type GameInfo,
  type LaunchValues,
  type RunInfo,
  type ServerView,
} from '@skali/shared'

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface AppSettings {
  allowlist: string[]
  connectHost: string
}

export interface ValheimWorld {
  name: string
  fwlPath: string
  modified: string
}

/** Result of POST /api/servers/inspect (`worlds` only for Valheim). */
export type InspectResult =
  | { ok: true; exe: string; launch: LaunchValues; notes: string[]; worlds?: ValheimWorld[] }
  | { ok: false; reason: string }

export interface ServerPatch {
  name?: string
  launch?: LaunchValues
  autoRestart?: boolean
  autoStart?: boolean
  stopTimeoutSec?: number
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  // The server rejects every non-GET/HEAD request without this header (CSRF guard).
  if (method !== 'GET' && method !== 'HEAD') headers[SKALI_HEADER] = SKALI_HEADER_VALUE
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError(0, 'Cannot reach Skáli')
  }
  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`
    try {
      const data = (await res.json()) as { error?: unknown }
      if (typeof data.error === 'string' && data.error) message = data.error
    } catch {
      // not JSON: keep the status text
    }
    throw new ApiError(res.status, message)
  }
  if (res.status === 204) return undefined as T
  try {
    return (await res.json()) as T
  } catch {
    throw new ApiError(res.status, 'Unexpected response from Skáli')
  }
}

const enc = encodeURIComponent
const srv = (id: string) => `/api/servers/${enc(id)}`

export const getGames = () => request<GameInfo[]>('GET', '/api/games')
export const getServers = () => request<ServerView[]>('GET', '/api/servers')
export const getServer = (id: string) => request<ServerView>('GET', srv(id))
export const inspectFolder = (game: string, folder: string) =>
  request<InspectResult>('POST', '/api/servers/inspect', { game, folder })
export const adoptServer = (req: AdoptRequest) => request<ServerView>('POST', '/api/servers', req)
export const patchServer = (id: string, patch: ServerPatch) => request<ServerView>('PATCH', srv(id), patch)
export const deleteServer = (id: string) => request<void>('DELETE', srv(id))
/** 202: the operation has begun; the outcome arrives over the WebSocket. */
export const startServer = (id: string) => request<ServerView>('POST', `${srv(id)}/start`)
export const stopServer = (id: string) => request<ServerView>('POST', `${srv(id)}/stop`)
export const restartServer = (id: string) => request<ServerView>('POST', `${srv(id)}/restart`)
export const sendCommand = (id: string, command: string) =>
  request<{ output: string }>('POST', `${srv(id)}/command`, { command })
export const acceptEula = (id: string) => request<void>('POST', `${srv(id)}/eula`)
export const getRuns = (id: string) => request<RunInfo[]>('GET', `${srv(id)}/runs`)
/** The raw text of a finished (or current) run's console log. */
export async function getRunLog(id: string, runId: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(runLogUrl(id, runId))
  } catch {
    throw new ApiError(0, 'Cannot reach Skáli')
  }
  if (!res.ok) throw new ApiError(res.status, res.status === 404 ? 'Run not found' : `Request failed (${res.status})`)
  return res.text()
}
export const runLogUrl = (id: string, runId: string) => `${srv(id)}/runs/${enc(runId)}/log`
export const browseFs = (path?: string) =>
  request<FsListing>('GET', path === undefined ? '/api/fs' : `/api/fs?path=${enc(path)}`)
export const getSettings = () => request<AppSettings>('GET', '/api/settings')
export const putSettings = (patch: Partial<AppSettings>) => request<AppSettings>('PUT', '/api/settings', patch)

// ---------- Deploys (proxied to the deploy helper; 503 "helper-not-running" when it isn't installed/started) ----------

export const HELPER_NOT_RUNNING = 'helper-not-running'
export const getDeployStatus = () => request<DeployStatusView>('GET', '/api/deploys/status')
/** Without `from` the whole log; with it, what was appended since that byte offset (`next` is the new offset). */
export const getDeployLog = (id: string, from?: number) =>
  request<DeployLogChunk>('GET', `/api/deploys/events/${enc(id)}/log${from === undefined ? '' : `?from=${from}`}`)
export const deployNow = () => request<unknown>('POST', '/api/deploys/deploy-now')
export const restartSkali = () => request<unknown>('POST', '/api/deploys/restart')
export const pauseDeploys = () => request<unknown>('POST', '/api/deploys/pause')
export const resumeDeploys = () => request<unknown>('POST', '/api/deploys/resume')
export const rollbackDeploy = (sha: string) => request<unknown>('POST', `/api/deploys/rollback/${enc(sha)}`)

// ---------- Settings editor (per-server config files) ----------

const cfg = (id: string) => `${srv(id)}/config`
const cfgFile = (id: string, sourceId: string) => `${cfg(id)}/files/${enc(sourceId)}`
export const listConfigSources = (id: string) => request<ConfigSourceView[]>('GET', `${cfg(id)}/sources`)
export const readConfig = (id: string, sourceId: string) => request<ConfigFileView>('GET', cfgFile(id, sourceId))
export const previewConfig = (id: string, sourceId: string, edit: Omit<ConfigSaveRequest, 'etag'>) =>
  request<ConfigFileView>('POST', `${cfgFile(id, sourceId)}/preview`, edit)
/** 409 when the file changed on disk since `req.etag` was read. */
export const saveConfig = (id: string, sourceId: string, req: ConfigSaveRequest) =>
  request<ConfigSaveResult>('PUT', cfgFile(id, sourceId), req)
export const configHistory = (id: string, sourceId: string) =>
  request<ConfigHistoryEntry[]>('GET', `${cfgFile(id, sourceId)}/history`)
export const configHistoryRaw = (id: string, sourceId: string, entryId: string) =>
  request<{ raw: string }>('GET', `${cfgFile(id, sourceId)}/history/${enc(entryId)}`)
export const restoreConfig = (id: string, sourceId: string, entryId: string, etag: string) =>
  request<ConfigSaveResult>('POST', `${cfgFile(id, sourceId)}/history/${enc(entryId)}/restore`, { etag })
export const addConfigSource = (id: string, src: { path: string; format?: ConfigFormat; label?: string }) =>
  request<ConfigSourceView>('POST', `${cfg(id)}/sources`, src)
export const updateConfigSource = (id: string, sourceId: string, patch: { format?: ConfigFormat; label?: string }) =>
  request<ConfigSourceView>('PATCH', `${cfg(id)}/sources/${enc(sourceId)}`, patch)
export const removeConfigSource = (id: string, sourceId: string) =>
  request<void>('DELETE', `${cfg(id)}/sources/${enc(sourceId)}`)
