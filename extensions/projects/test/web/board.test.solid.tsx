import { createAgent } from '@ui-sdk/solid/agent'
import { flush } from 'solid-js'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import type { BoardProject } from '../../refs.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  projects: [] as BoardProject[],
  failing: false,
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const subscriptions = fakeSubscriptions(harness.sources)
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path !== '/api/extensions/projects/actions/board')
      return subscriptions.handle(path, init) ?? Response.json({ ok: true })
    if (harness.failing) return Response.json({ error: 'board failed' }, { status: 500 })
    return Response.json({ result: harness.projects })
  }
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const store = createStore({
    eventSource: (url) => {
      const source = new FakeSource(url)
      harness.sources.push(source)
      return source
    },
    fetch: pageFetch,
  })
  const api = createApi(store, { fetch: pageFetch })
  return {
    store,
    api,
    reads: createReads(api, store),
    uiState: createUiState(undefined),
    registry: createRegistry(),
  }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { ProjectGrid } from '../../board.solid.tsx'

const agent = createAgent()
beforeAll(() => vi.useFakeTimers())
afterAll(() => vi.useRealTimers())
beforeEach(async () => {
  harness.sources.length = 0
  harness.failing = false
  harness.projects = [
    {
      name: 'ultimate',
      root: '/work/ultimate',
      current: true,
      url: 'http://127.0.0.1:4747',
      previews: 1,
      state: {
        questions: { count: 0 },
        branches: [{ id: 7, title: 'Board', busy: true }],
        failures: 0,
      },
    },
    {
      name: 'my-app',
      root: '/work/my-app',
      current: false,
      url: 'http://127.0.0.1:4748',
      previews: 0,
      state: {
        questions: { count: 2, first: 'Ship it?' },
        branches: [],
        failures: 1,
        behind: 3,
        landing: { title: 'Login page', at: 0 },
      },
    },
    { name: 'old-app', root: '/work/old-app', current: false, activeAt: 0, previews: 0 },
  ]
  store.start()
  harness.sources[0].open()
  await vi.advanceTimersByTimeAsync(5_000)
})
afterEach(() => store.stop())

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
  flush()
}

it('shows each project’s state, links running ones and offers a stopped one’s start command, with distinct agent names', async () => {
  const container = renderSolid(() => <ProjectGrid />)
  await advance(100)
  const cards = [...container.querySelectorAll<HTMLElement>('[data-project]')]
  expect(cards.map((card) => [card.dataset.project, card.getAttribute('href')])).toEqual([
    ['ultimate', null],
    ['my-app', 'http://127.0.0.1:4748/'],
    ['old-app', null],
  ])
  expect(cards[0].textContent).toContain('Board')
  expect(cards[0].textContent).toContain('+1 preview')
  expect(cards[1].textContent).toContain('Ship it?')
  expect(cards[1].textContent).toContain('landed Login page')
  expect(cards[1].textContent).toContain('1 failure today')
  expect(cards[1].textContent).toContain('3 behind origin')
  expect(cards[2].textContent).toContain('stopped')
  expect(container.textContent).toContain('2 running · 1 stopped')
  await expectDistinctAgentNames(agent)
  expect(await agent.query({ text: 'ultimate /work/old-app' })).toEqual([
    expect.objectContaining({ label: 'Copy start command of old-app: ultimate /work/old-app' }),
  ])

  harness.failing = true
  await advance(4_000)
  expect(container.querySelectorAll('[data-project]')).toHaveLength(3)
})
