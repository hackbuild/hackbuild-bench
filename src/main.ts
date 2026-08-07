import { createApp } from 'vue'
import { createPinia } from 'pinia'

import '@virgilvox/hackbuild-ui/styles.css'
import './styles/bench.css'

import App from './App.vue'
import { installDrivers } from './core/drivers/registry'
import { installTools } from './tools'

installDrivers()
installTools()

createApp(App).use(createPinia()).mount('#app')
