import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localMatchingService } from "./scripts/dev-matching";

export default defineConfig({
  plugins: [react(), localMatchingService()],
  server: { port: 5173 },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/")) return "react-vendor";
          if (id.includes("/node_modules/@supabase/")) return "supabase-vendor";
        },
      },
    },
  },
});
