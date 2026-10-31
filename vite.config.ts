import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed port and no screen clearing.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // The chart (ECharts) chunk is ~590 kB but loads only when a chart is shown; startup JS is far smaller.
  build: { chunkSizeWarningLimit: 650 },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
});
