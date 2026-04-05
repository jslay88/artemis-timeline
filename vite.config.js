import { defineConfig } from "vite";

export default defineConfig({
  base: "/artemis-timeline/",
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
    open: false,
  },
});
