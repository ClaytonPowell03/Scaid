import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import { createGeminiApiMiddleware } from './server/gemini-api.js';

function geminiApiPlugin(env) {
  const middleware = createGeminiApiMiddleware(env);
  return {
    name: 'scad-gemini-api',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig(({ mode }) => {
  const loaded = loadEnv(mode, process.cwd(), '');
  const env = { ...process.env, ...loaded };

  return {
    plugins: [geminiApiPlugin(env)],
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          render: resolve(__dirname, 'render.html'),
          gallery: resolve(__dirname, 'gallery.html'),
          guide: resolve(__dirname, 'openscad-guide.html'),
        },
      },
    },
    server: {
      open: true,
    },
  };
});
