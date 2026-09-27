import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const editorHtml = fileURLToPath(new URL("./editor.html", import.meta.url));
const gameHtml = fileURLToPath(new URL("./index.html", import.meta.url));

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
  },
  build: {
    outDir: "dist",
    target: "es2022",
    rollupOptions: {
      input: { game: gameHtml, editor: editorHtml },
    },
  },
});
