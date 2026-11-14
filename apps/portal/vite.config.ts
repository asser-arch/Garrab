import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built into the site Worker's assets; served at app.<domain>/portal/.
export default defineConfig({
  base: "/portal/",
  plugins: [react()],
  build: { outDir: "../site/public/portal", emptyOutDir: true, sourcemap: false },
});
