import { defineAsyncComponent } from 'vue'
import type { Component } from 'vue'
import ToolLoadError from '@/components/bench/ToolLoadError.vue'

/**
 * A tool panel loaded the first time it is opened.
 *
 * Each deploy renames the files a panel loads from, so a page opened before a
 * deploy asks for files that are gone. Without an error component that shows
 * as an empty panel. One retry covers a dropped connection, and after that
 * the panel says what happened and offers the reload that fixes it.
 */
export function lazyTool(loader: () => Promise<Component | { default: Component }>): Component {
  return defineAsyncComponent({
    loader,
    errorComponent: ToolLoadError,
    onError(_err, retry, fail, attempts) {
      if (attempts <= 1) retry()
      else fail()
    },
  })
}
