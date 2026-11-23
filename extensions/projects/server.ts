import { join } from 'node:path'
import type { JsonValue } from '@earendil-works/chord/json'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen, meansNone } from '../../lib/errors.ts'
import { readJson, updateJson } from '../../lib/json-file.ts'
import { githubRepo, readGithubRepo } from '../../lib/project-identity.ts'
import type { GithubRepo } from '../../lib/project-identity.ts'
import { postAction } from '../../lib/remote.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { MessagesApi } from '../messages/api.ts'
import { BoardAction, ListAction, PinAction } from './refs.ts'
import type { BoardProject, ProjectState, RunningProject } from './refs.ts'
import type { RootEvent } from '../lineage/types.ts'
import type { Status } from '../status/refs.ts'

const REMOTE_COUNTS_TIMEOUT_MS = 1_500
const DAY = 24 * 60 * 60_000

type Counts = { busy: number; questions: number }

async function localCounts(host: ExtensionHost): Promise<Counts> {
  return {
    busy: host.conversations().filter((conversation) => conversation.busy).length,
    questions: (await host.need(MessagesApi).openQuestions(context)).length,
  }
}

async function timedRemoteCounts(name: string, url: string, signal: AbortSignal) {
  const status = (await postAction(
    { url, label: name },
    'status',
    'status',
    {},
    AbortSignal.any([signal, AbortSignal.timeout(REMOTE_COUNTS_TIMEOUT_MS)]),
  ).catch(meansNone)) as { busy?: unknown; questions?: { count?: unknown } } | undefined
  const busy = status?.busy
  const questions = status?.questions?.count
  return typeof busy === 'number' && typeof questions === 'number' ? { busy, questions } : {}
}

const repoCache = new Map<string, GithubRepo | null>()
const pendingRepoReads = new Set<string>()
function cachedRepo(root: string | undefined) {
  if (!root) return undefined
  if (!repoCache.has(root) && !pendingRepoReads.has(root)) {
    pendingRepoReads.add(root)
    rebuiltOnOpen(
      'a later project list reads the repository cache again',
      (async () => {
        const key = await githubRepo(root)
        repoCache.set(root, key ? await readGithubRepo(key) : null)
        pendingRepoReads.delete(root)
      })(),
    )
  }
  return repoCache.get(root) ?? undefined
}

function checkoutName(name: string, root: string | undefined) {
  const worktree = /\/\.ultimate\/projects\/(.+)-[\da-f]{8}\/worktrees\/(\d+)$/.exec(root ?? '')
  return worktree ? `${worktree[1]} #${worktree[2]}` : name
}

async function tailnetPorts(host: ExtensionHost) {
  type Registry = { ports?: Record<string, { port?: unknown }> }
  const registryOrNoPorts = await readJson<Registry>(
    join(host.userHome, '.ultimate', 'tailscale.json'),
    {},
  ).catch((): Registry => ({}))
  const ports: Record<string, number> = {}
  for (const [root, entry] of Object.entries(registryOrNoPorts.ports ?? {}))
    if (typeof entry?.port === 'number') ports[root] = entry.port
  return ports
}

export async function list(host: ExtensionHost, signal: AbortSignal): Promise<RunningProject[]> {
  const tailnet = await tailnetPorts(host)
  return Promise.all(
    (await host.projects()).flatMap(({ name, root, running, current }) => {
      const processOrLockUrl = current ? host.system().process.url : running?.url
      if (!processOrLockUrl) return []
      return [
        (async () => {
          const repo = cachedRepo(root)
          return {
            name: checkoutName(name, root),
            url: processOrLockUrl,
            current,
            ...(repo && { repo: { name: repo.name, url: repo.url, visibility: repo.visibility } }),
            ...(root && tailnet[root] ? { tailnetPort: tailnet[root] } : {}),
            ...(current
              ? await localCounts(host)
              : await timedRemoteCounts(name, processOrLockUrl, signal)),
          }
        })(),
      ]
    }),
  )
}

function withinDeadline<T>(work: () => Promise<T>, deadline: AbortSignal) {
  if (deadline.aborted) return Promise.reject(deadline.reason as Error)
  return Promise.race([
    work(),
    new Promise<never>((_, reject) =>
      deadline.addEventListener('abort', () => reject(deadline.reason as Error), { once: true }),
    ),
  ])
}

const FAILURES_KEPT = 20

async function projectState(
  call: (extension: string, action: string, args: JsonValue) => Promise<unknown>,
): Promise<ProjectState | undefined> {
  const lastLanding = async () => {
    const info = (await call('lineage', 'info', null)) as { roots?: number[] }
    const root = info.roots?.[0]
    if (root === undefined) return undefined
    const [event] = (await call('lineage', 'recent', {
      id: root,
      limit: 1,
      types: ['landed'],
    })) as RootEvent[]
    return event
  }
  const [status, landing] = await Promise.all([
    call('status', 'status', { since: Date.now() - DAY }).catch(meansNone) as Promise<
      Partial<Status> | undefined
    >,
    lastLanding().catch(meansNone),
  ])
  if (!status?.questions) return undefined
  const failures = status.failures?.length ?? 0
  return {
    questions: {
      count: status.questions.count,
      ...(status.questions.first?.text ? { first: status.questions.first.text } : {}),
    },
    branches: (status.branches ?? []).map(({ id, title, busy }) => ({
      id,
      ...(title ? { title } : {}),
      busy,
    })),
    failures,
    ...(failures >= FAILURES_KEPT ? { failuresCapped: true } : {}),
    ...(landing?.type === 'landed'
      ? {
          landing: {
            ...(landing.title ? { title: landing.title } : {}),
            ...(landing.feature ? { feature: landing.feature } : {}),
            ...(landing.at ? { at: landing.at } : {}),
          },
        }
      : {}),
  }
}

async function runningPreviews(
  call: (extension: string, action: string, args: JsonValue) => Promise<unknown>,
) {
  const listed = (await call('instance', 'list', null).catch(meansNone)) as
    | { running?: unknown }[]
    | undefined
  return Array.isArray(listed) ? listed.filter((preview) => preview.running === true).length : 0
}

export async function board(host: ExtensionHost, signal: AbortSignal): Promise<BoardProject[]> {
  const tailnet = await tailnetPorts(host)
  const boarded = await Promise.all(
    (await host.projects()).map(
      async ({
        root,
        running,
        current,
        conversations,
        openedAt,
        ...project
      }): Promise<BoardProject> => {
        const name = checkoutName(project.name, root)
        const url = current ? host.system().process.url : running?.url
        const repo = cachedRepo(root)
        const activeAt =
          Math.max(
            0,
            ...conversations.map(({ inputAt, answerAt }) => Math.max(inputAt ?? 0, answerAt ?? 0)),
          ) || openedAt
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(REMOTE_COUNTS_TIMEOUT_MS)])
        const call = (extension: string, action: string, args: JsonValue) =>
          withinDeadline(
            () =>
              current
                ? host.invoke(extension, action, args, deadline)
                : postAction({ url: url!, label: name }, extension, action, args, deadline),
            deadline,
          )
        const [state, previews] = !url
          ? [undefined, 0]
          : await Promise.all([projectState(call), runningPreviews(call)])
        return {
          name,
          ...(root ? { root } : {}),
          current,
          ...(url ? { url } : {}),
          ...(repo && { repo: { name: repo.name, url: repo.url, visibility: repo.visibility } }),
          ...(root && tailnet[root] ? { tailnetPort: tailnet[root] } : {}),
          ...(activeAt ? { activeAt } : {}),
          previews,
          ...(state ? { state } : {}),
        }
      },
    ),
  )
  const rank = (project: BoardProject) => (project.current ? 0 : project.url ? 1 : 2)
  return boarded.toSorted((a, b) => rank(a) - rank(b) || (b.activeAt ?? 0) - (a.activeAt ?? 0))
}

const sharedRailPinPath = (host: ExtensionHost) =>
  join(host.userHome, '.ultimate', 'projects-rail.json')
const readPin = async (path: string) => {
  const value = await readJson<{ pinned?: unknown }>(path, {})
  return { pinned: value.pinned === true }
}

export default function projects(host: ExtensionHost) {
  host.need(MessagesApi)
  return defineExtension({ name: 'projects' })
}

export const pollActions = ['list', 'pin', 'board']

export const actions = {
  board: implementAction(BoardAction, (_args, { host, signal }) => board(host, signal)),
  list: implementAction(ListAction, (_args, { host, signal }) => list(host, signal)),
  pin: implementAction(PinAction, async (args, { host }) => {
    const pinned =
      args && typeof args === 'object' && !Array.isArray(args) ? args.pinned : undefined
    if (pinned !== undefined && typeof pinned !== 'boolean')
      throw new Error('pinned must be a boolean')
    const path = sharedRailPinPath(host)
    if (pinned !== undefined)
      await updateJson(path, readPin, (value) => {
        value.pinned = pinned
      })
    return readPin(path)
  }),
}
