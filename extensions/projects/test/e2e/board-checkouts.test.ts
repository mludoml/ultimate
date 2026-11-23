import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { git } from '../../../../lib/git.ts'
import type { ExtensionHost } from '../../../../server/extensions.ts'
import { temp } from '../../../../test/helpers.ts'
import { board } from '../../server.ts'

it('counts a checkout as a preview of the project whose repository it shares, wherever it lives, and gives it no card, while a project in a subfolder keeps its own', async () => {
  const base = await temp('ultimate-board-')
  const main = join(base, 'app')
  const elsewhere = join(base, 'checkouts', 'app-12')
  await mkdir(main)
  await git(main, 'init', '-q')
  await git(
    main,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'first',
  )
  await git(main, 'worktree', 'add', '-q', elsewhere)
  const sub = join(main, 'packages', 'web')
  await mkdir(sub, { recursive: true })
  const host = {
    userHome: base,
    projects: async () => [
      { name: 'app', root: main, home: '/homes/app', current: false, conversations: [] },
      { name: 'web', root: sub, home: '/homes/web', current: false, conversations: [] },
      {
        name: 'app-12',
        root: elsewhere,
        home: '/homes/app-12',
        current: false,
        running: { pid: 3, url: 'http://127.0.0.1:1' },
        conversations: [],
      },
    ],
    system: () => ({ process: { url: 'http://127.0.0.1:4747' } }),
  } as unknown as ExtensionHost
  expect(await board(host, AbortSignal.abort())).toEqual([
    { name: 'app', root: main, current: false, previews: 1 },
    { name: 'web', root: sub, current: false, previews: 0 },
  ])
})
