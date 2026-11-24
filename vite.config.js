import { defineConfig } from "vite";

// base "./": funktioniert unter jeder Adresse, z. B. https://name.github.io/repo/
export default defineConfig({
  base: "./",
  build: { target: "es2020", sourcemap: false },
  test: { include: ["tests/**/*.test.js"] },
});
