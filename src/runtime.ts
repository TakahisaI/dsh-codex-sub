import type { Context } from '@deepseek-ai/cordis'

import { apply } from './dsh/plugin.js'

export function applyRuntime(ctx: Context): void {
  apply(ctx)
}
