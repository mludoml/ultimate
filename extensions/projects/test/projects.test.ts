import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { board, list } from '../server.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { temp } from '../../../test/helpers.ts'

it('lists running projects and this one, with their own counts, another instance’s from its status, and one that fails without them', async () => {
  const other = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ result: { busy: 2, questions: { count: 1 } } }))
  })
  await new Promise<void>((done) => other.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
  const userHome = await temp('ultimate-projects-')
  const host = {
    userHome,
    projects: async () => [
      { name: 'down', current: false, running: { pid: 1, url: 'http://127.0.0.1:1' } },
      { name: 'stopped', current: false },
      { name: 'here', current: true },
      { name: 'other', current: false, running: { pid: 3, url } },
    ],
    system: () => ({ process: { url: 'http://127.0.0.1:4747' } }),
    conversations: () => [{ busy: true }, { busy: false }],
    need: () => ({ openQuestions: async () => [{}, {}, {}] }),
  } as unknown as ExtensionHost
  try {
    // Without a Tailscale registry nothing is on the tailnet.
    expect(await list(host, new AbortController().signal)).toEqual([
      { name: 'down', url: 'http://127.0.0.1:1', current: false },
      { name: 'here', url: 'http://127.0.0.1:4747', current: true, busy: 1, questions: 3 },
      { name: 'other', url, current: false, busy: 2, questions: 1 },
    ])
  } finally {
    other.close()
  }
})

it('names the Tailscale port of each project the registry knows, for pages opened over the tailnet', async () => {
  const userHome = await temp('ultimate-projects-')
  await mkdir(join(userHome, '.ultimate'))
  await writeFile(
    join(userHome, '.ultimate/tailscale.json'),
    JSON.stringify({ ports: { '/work/here': { port: 4752 }, '/work/other': { port: 'x' } } }),
  )
  const host = {
    userHome,
    projects: async () => [
      { name: 'here', root: '/work/here', current: true },
      {
        name: 'other',
        root: '/work/other',
        current: false,
        running: { pid: 2, url: 'http://127.0.0.1:1' },
      },
      {
        name: 'unpublished',
        root: '/work/unpublished',
        current: false,
        running: { pid: 3, url: 'http://127.0.0.1:2' },
      },
    ],
    system: () => ({ process: { url: 'http://127.0.0.1:4747' } }),
    conversations: () => [],
    need: () => ({ openQuestions: async () => [] }),
  } as unknown as ExtensionHost
  const projects = await list(host, new AbortController().signal)
  // Only a numeric port counts; a project the registry does not hold, or holds without one, has none.
  expect(projects.map(({ name, tailnetPort }) => [name, tailnetPort])).toEqual([
    ['here', 4752],
    ['other', undefined],
    ['unpublished', undefined],
  ])
})

it('boards every project: this one and another running with their state, and a stopped one with its last activity', async () => {
  const other = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    const action = request.url!.split('/').slice(-3).join('/')
    const results: Record<string, unknown> = {
      'status/actions/status': {
        questions: { count: 1, first: { text: 'Ship it?' } },
        branches: [{ id: 7, title: 'Fix it', busy: true, inputAt: 5 }],
        failures: [{}],
        head: { behind: 2 },
      },
      'lineage/actions/info': { roots: [1] },
      'lineage/actions/recent': [{ type: 'landed', title: 'Board', at: 40, sha: 'abc' }],
    }
    response.end(JSON.stringify({ result: results[action] }))
  })
  await new Promise<void>((done) => other.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
  const userHome = await temp('ultimate-projects-')
  const host = {
    userHome,
    projects: async () => [
      {
        name: 'stopped',
        root: '/work/stopped',
        home: '/homes/stopped',
        openedAt: 3,
        current: false,
        conversations: [{ id: 1, inputAt: 9, answerAt: 12 }],
      },
      {
        name: 'other',
        root: '/work/other',
        home: '/homes/other',
        current: false,
        running: { pid: 2, url },
        conversations: [],
      },
      { name: 'here', root: '/work/here', home: '/homes/here', current: true, conversations: [] },
    ],
    system: () => ({ process: { url: 'http://127.0.0.1:4747' } }),
    invoke: async (extension: string) => {
      if (extension === 'status') return { questions: { count: 0 }, branches: [] }
      throw new Error('lineage is off')
    },
  } as unknown as ExtensionHost
  try {
    expect(await board(host, new AbortController().signal)).toEqual([
      {
        name: 'here',
        root: '/work/here',
        current: true,
        url: 'http://127.0.0.1:4747',
        previews: 0,
        state: { questions: { count: 0 }, branches: [], failures: 0 },
      },
      {
        name: 'other',
        root: '/work/other',
        current: false,
        url,
        previews: 0,
        state: {
          questions: { count: 1, first: 'Ship it?' },
          branches: [{ id: 7, title: 'Fix it', busy: true }],
          failures: 1,
          behind: 2,
          landing: { title: 'Board', at: 40 },
        },
      },
      { name: 'stopped', root: '/work/stopped', current: false, activeAt: 12, previews: 0 },
    ])
  } finally {
    other.close()
  }
})

it('leaves out the state of a project whose deadline has passed, without asking it', async () => {
  const asked: string[] = []
  const host = {
    userHome: await temp('ultimate-projects-'),
    projects: async () => [
      { name: 'here', home: '/homes/here', openedAt: 5, current: true, conversations: [] },
    ],
    system: () => ({ process: { url: 'http://127.0.0.1:4747' } }),
    invoke: (extension: string) => {
      asked.push(extension)
      return new Promise(() => {})
    },
  } as unknown as ExtensionHost
  expect(await board(host, AbortSignal.abort())).toEqual([
    { name: 'here', current: true, url: 'http://127.0.0.1:4747', activeAt: 5, previews: 0 },
  ])
  expect(asked).toEqual([])
})
