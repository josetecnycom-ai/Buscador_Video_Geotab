import { defineConfig } from "vite";

export default defineConfig({
  // The app is served from a project path on GitHub Pages and embedded by
  // MyGeotab. Relative assets avoid duplicating the repository path in its iframe.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
