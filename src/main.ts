import { createApp } from 'vue'
import { createPinia } from 'pinia'

import '@virgilvox/hackbuild-ui/styles.css'
import './styles/bench.css'

import App from './App.vue'
import { bus } from './core/bus/DeviceBus'
import { installDrivers } from './core/drivers/registry'
import { installTools } from './tools'

installDrivers()
installTools()

createApp(App).use(createPinia()).mount('#app')

/**
 * Vue lifecycle hooks do not run when the page itself goes away, so a reload
 * or a closed tab used to leave a radio in receive with nothing reading it.
 * A hackrf left that way can need a replug before it answers again.
 */
window.addEventListener('pagehide', () => {
  void bus.detachAll()
})
