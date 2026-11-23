import { LayoutGrid } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import type { ComponentProps } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { CopyValue } from '@/components/ui/copy-value.solid.tsx'
import { Skeleton } from '@/components/ui/skeleton.solid.tsx'
import {
  Header,
  StatusLine,
  cn,
  formatAgo,
  keepLast,
  plural,
  prettyName,
  showSurface,
  shortenPath,
  switchConversation,
  useAction,
  useNow,
  usePageVisible,
  useSystem,
} from '@/sdk/solid'
import { ProjectSwatch, RepoLabel } from '../sidebar/ui.solid.tsx'
import { talkToUltimate } from '../subagents/ui.solid.tsx'
import { target } from './links.ts'
import { BoardAction } from './refs.ts'
import type { BoardProject } from './refs.ts'

const BOARD_POLL_MS = 4_000

export const shellQuoted = (path: string) =>
  /^[\w./~-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`
const SHOWN_BRANCHES = 3

export function Board() {
  return (
    <>
      <Header>
        <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <LayoutGrid class="size-4 text-muted-foreground" />
          Projects
        </span>
      </Header>
      <ProjectGrid />
      <StatusLine />
    </>
  )
}

export function ProjectGrid() {
  const visible = usePageVisible()
  const board = useAction(BoardAction, null, {
    on: visible,
    onError: keepLast,
    every: () => (visible() ? BOARD_POLL_MS : undefined),
  })
  const projects = () => board.data() ?? []
  const family = createMemo(() => projects().map((project) => project.name))
  const running = () => projects().filter((project) => project.url).length
  const label = (project: BoardProject) => {
    const name = prettyName(project.name)
    const shared = projects().filter((other) => prettyName(other.name) === name).length > 1
    return shared && project.root ? `${name} (${project.root})` : name
  }
  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <p class="px-4 pt-3 font-mono text-[11px] text-muted-foreground/70 tabular-nums">
        {board.data() ? `${running()} running · ${projects().length - running()} stopped` : ''}
      </p>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3 p-4 pt-2">
        <Show when={board.data()} fallback={<BoardSkeleton />}>
          <For each={projects()} keyed={(project) => project.root ?? project.name}>
            {(project) => (
              <ProjectCard family={family()} label={label(project())} project={project()} />
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

function BoardSkeleton() {
  return <For each={[0, 1, 2]}>{() => <Skeleton class="h-36 rounded-lg bg-muted/40" />}</For>
}

function ProjectCard(props: { project: BoardProject; label: string; family: readonly string[] }) {
  const system = useSystem()
  const now = useNow(60_000)
  const state = () => props.project.state
  const href = () =>
    props.project.url && !props.project.current
      ? target({ url: props.project.url, tailnetPort: props.project.tailnetPort }, location)
      : undefined
  const questions = () => state()?.questions.count ?? 0
  const working = () => state()?.branches.filter((branch) => branch.busy).length ?? 0
  const body = (
    <>
      <span class="flex items-start gap-3">
        <ProjectSwatch
          class={cn('mt-0.5 h-9 w-1.5 shrink-0 rounded-full', !props.project.url && 'opacity-40')}
          family={props.family}
          folder={props.project.name}
        />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="flex items-center gap-2">
            <span class="truncate text-[14px] font-medium text-foreground">
              {prettyName(props.project.name)}
            </span>
            <Show when={props.project.current}>
              <span class="font-mono text-[10px] text-muted-foreground/70">this tab</span>
            </Show>
            <span class="ml-auto shrink-0">
              <Show
                when={questions() > 0}
                fallback={
                  <Show when={working() > 0}>
                    <span class="flex items-center gap-1.5 font-mono text-[10px] text-brand">
                      <span class="size-1.5 animate-pulse-dot rounded-full bg-brand" />
                      working
                    </span>
                  </Show>
                }
              >
                <span class="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400/15 px-1.5 font-mono text-[10px] font-semibold text-amber-700 tabular-nums ring-1 ring-amber-500/30 ring-inset dark:text-amber-300">
                  {questions()}
                </span>
              </Show>
            </span>
          </span>
          <span class="flex min-w-0 items-center gap-1.5 font-mono text-[10px] leading-4 text-muted-foreground/80">
            <Show
              when={props.project.repo}
              fallback={
                <span class="truncate">
                  {shortenPath(props.project.root ?? '', { home: system()?.machine.home })}
                </span>
              }
            >
              {(repo) => <RepoLabel class="min-w-0" repo={repo()} />}
            </Show>
            <Show when={props.project.previews > 0}>
              <span class="shrink-0 text-muted-foreground/60">
                · +{plural(props.project.previews, 'preview')}
              </span>
            </Show>
          </span>
        </span>
      </span>
      <Show
        when={props.project.url}
        fallback={<Stopped label={props.label} now={now()} project={props.project} />}
      >
        <Show
          when={state()}
          fallback={<p class="font-mono text-[11px] text-muted-foreground/70">not answering</p>}
        >
          {(known) => <Running now={now()} state={known()} />}
        </Show>
      </Show>
    </>
  )
  const card = (render?: ComponentProps<typeof Button>['render']) => (
    <Button
      aria-label={`Open ${props.label}`}
      class="flex h-auto w-full flex-col items-stretch justify-start gap-3 rounded-lg border border-border/70 bg-card p-3.5 text-left font-normal whitespace-normal transition-colors hover:border-border hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-45 data-disabled:opacity-45"
      data-project={props.project.name}
      disabled={!props.project.current && !href()}
      onClick={() =>
        props.project.current ? talkToUltimate({ showSurface, switchConversation }) : undefined
      }
      render={render}
      size={null}
      variant={null}
    >
      {body}
    </Button>
  )
  return (
    <Show
      when={props.project.url}
      fallback={
        <div
          class="flex flex-col gap-3 rounded-lg border border-dashed border-border/60 p-3.5 opacity-75"
          data-project={props.project.name}
        >
          {body}
        </div>
      }
    >
      <Show when={href()} fallback={card()}>
        {(link) =>
          card((anchor) => (
            <a {...anchor} href={link()}>
              {anchor.children}
            </a>
          ))
        }
      </Show>
    </Show>
  )
}

function Running(props: { state: NonNullable<BoardProject['state']>; now: number }) {
  const shown = () => props.state.branches.slice(0, SHOWN_BRANCHES)
  const more = () => props.state.branches.length - SHOWN_BRANCHES
  return (
    <span class="flex flex-col gap-2 text-[12px]">
      <Show when={props.state.questions.first}>
        {(first) => (
          <span class="line-clamp-2 border-l-2 border-amber-400/70 pl-2 text-amber-800 dark:text-amber-200">
            {first()}
          </span>
        )}
      </Show>
      <span class="flex flex-col gap-0.5">
        <Show
          when={props.state.branches.length > 0}
          fallback={<span class="text-muted-foreground/70">no open branches</span>}
        >
          <For each={shown()} keyed={(branch) => branch.id}>
            {(branch) => (
              <span class="flex min-w-0 items-center gap-2">
                <span
                  class={cn(
                    'size-1.5 shrink-0 rounded-full',
                    branch().busy ? 'animate-pulse-dot bg-brand' : 'bg-muted-foreground/30',
                  )}
                />
                <span class="truncate text-foreground/85">
                  {branch().title ?? `#${branch().id}`}
                </span>
              </span>
            )}
          </For>
          <Show when={more() > 0}>
            <span class="pl-3.5 font-mono text-[10px] text-muted-foreground/70">
              +{more()} more
            </span>
          </Show>
        </Show>
      </span>
      <span class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground/80">
        <Show when={props.state.landing}>
          {(landing) => (
            <span class="min-w-0 truncate">
              landed {landing().title ?? landing().feature ?? ''}
              <Show when={landing().at}>
                {(at) => (
                  <span class="text-muted-foreground/60"> · {formatAgo(at(), props.now)}</span>
                )}
              </Show>
            </span>
          )}
        </Show>
        <Show when={props.state.failures > 0}>
          <span class="text-error">
            {props.state.failuresCapped
              ? `${props.state.failures}+ failures`
              : plural(props.state.failures, 'failure')}{' '}
            today
          </span>
        </Show>
        <Show when={(props.state.behind ?? 0) > 0}>
          <span class="text-warning">{props.state.behind} behind origin</span>
        </Show>
      </span>
    </span>
  )
}

function Stopped(props: { project: BoardProject; label: string; now: number }) {
  return (
    <span class="flex flex-col gap-1.5 font-mono text-[11px] text-muted-foreground">
      <span>
        stopped
        <Show when={props.project.activeAt}>
          {(at) => (
            <span class="text-muted-foreground/60">
              {' '}
              · active {formatAgo(at(), props.now, { ago: true })}
            </span>
          )}
        </Show>
      </span>
      <Show when={props.project.root}>
        {(root) => (
          <CopyValue
            field={`start command of ${props.label}`}
            value={`ultimate ${shellQuoted(root())}`}
          />
        )}
      </Show>
    </span>
  )
}
