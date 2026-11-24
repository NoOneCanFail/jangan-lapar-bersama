import { defineConfig } from "vite";

// Content Security Policy nur im fertigen Build (der Entwicklungsserver braucht Websockets).
// Erlaubt: eigene Dateien + Supabase. Keine fremden Skripte, keine Inline-Skripte.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // für style="--sauce:…" an den Schüsseln
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

export default defineConfig({
  base: "./",
  build: { target: "es2020", sourcemap: false },
  test: { include: ["tests/**/*.test.js"] },
  plugins: [{
    name: "csp",
    apply: "build",
    transformIndexHtml: html => html.replace("<head>", `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`),
  }],
});
