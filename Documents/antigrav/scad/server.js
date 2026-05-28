import express from 'express';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createApiMiddleware } from './server/gemini-api.js';
import { shutdownPostHog } from './server/posthog.js';

// Load local .env into process.env if present
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

// Mount the custom api middleware
const apiMiddleware = createApiMiddleware(process.env);
app.use(apiMiddleware); // Mount at root so req.url retains full path

// Serve the production build artifacts
const distPath = resolve(__dirname, 'dist');
app.use(express.static(distPath));

// For Single Page App navigation, fall back to index.html 
// (or render.html if explicitly requested, but static handles existings files first)
app.use((req, res, next) => {
  res.sendFile(resolve(distPath, 'index.html'));
});

app.listen(port, () => {
  console.log(`SCAD Studio production server running on http://localhost:${port}`);
});

process.on('SIGTERM', async () => {
  await shutdownPostHog();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await shutdownPostHog();
  process.exit(0);
});
