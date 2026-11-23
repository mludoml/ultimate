import { LayoutGridIcon } from '@lucide/solid'
import { defineWebExtension } from '@/sdk/solid'
import { Board } from './board.solid.tsx'
import { OpeningBar, Rail } from './rail.solid.tsx'

export default defineWebExtension({
  slots: { 'shell.rail': Rail, overlay: OpeningBar },
  surfaces: [
    {
      id: 'projects',
      title: 'Projects',
      icon: LayoutGridIcon,
      description: 'Every project on this machine and what waits in each',
      order: 5,
      component: Board,
    },
  ],
})
