import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
// 通过 `vite frontend`（从仓库根运行）把 Vite root 设到本目录，故 config /
// index.html / src / public 都从这里解析。
// 编辑器模型（`src/akstage/local/editorModel.js`）在 root 之外、且由多人并行
// 交付：用别名**按绝对路径**解析，避免相对说明符带来的转换缓存/监视盲区。
const editorModelPath = fileURLToPath(new URL('../src/akstage/local/editorModel.js', import.meta.url))
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@editor-model': editorModelPath },
  },
  // 对齐 Tauri 的 devUrl（src-tauri/tauri.conf.json），使 `tauri dev` 能连上。
  // fs.allow 放开上级目录：使用说明页 import 仓库根的 README.md?raw，把它内置进包。
  server: {
    port: 5174,
    strictPort: true,
    fs: {
      allow: [".."],
      // `deny` 默认含 `.env*`；显式列一份不含 `*` 的规则，顺带放开
      // `src/akstage/local/*.js`（编辑器页在无 Tauri 时只读演示它）。
      deny: [".env", ".env.local", "*.{crt,pem}", "**/.git/**"],
    },
  },
  build: {
    // 相对 Vite root（frontend/）解析 → 仓库根的 build/dist。
    outDir: '../build/dist',
    emptyOutDir: true,
    // 桌面应用（Tauri）本地加载，主包 ~2 MB（gzip 369 KB）完全可接受：
    // 抬阈值只为消掉 Vite 的「chunk > 500 kB」提示，不做无收益的拆包。
    chunkSizeWarningLimit: 2500,
  },
})
