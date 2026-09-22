import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { startScrollReveal } from './utils/scroll-reveal'
import './styles/tokens.css'
import './styles/base.css'

startScrollReveal()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
