import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 单 HTML 产物：JS/CSS 全内联；开发期 /api 代理到游戏内插件。
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:11777" } },
});
