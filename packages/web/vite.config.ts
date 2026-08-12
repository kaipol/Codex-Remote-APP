import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  plugins:[vue(),VitePWA({
    registerType:'autoUpdate',includeAssets:['icon.svg'],
    manifest:{name:'Codex Remote',short_name:'Codex',description:'自托管 Codex 移动桥',theme_color:'#000000',background_color:'#000000',display:'standalone',icons:[{src:'icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any maskable'}]},
    workbox:{navigateFallback:'index.html',navigateFallbackDenylist:[/^\/api\//,/^\/ws/],runtimeCaching:[]}
  })],
  build:{rollupOptions:{output:{manualChunks:{vue:['vue'],storage:['dexie']}}}},
  server:{port:5173,proxy:{'/api':'http://localhost:8787','/health':'http://localhost:8787','/ws':{target:'ws://localhost:8787',ws:true}}}
})
