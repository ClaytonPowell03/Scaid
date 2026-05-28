import { createApiMiddleware } from '../server/gemini-api.js';

export default async function handler(req, res) {
  // Pass the serverless Vercel environment to the middleware
  const middleware = createApiMiddleware(process.env);
  
  // Call the middleware with Vercel's Edge/Serverless request API. 
  // It handles its own responses or passes execution to next() 
  await middleware(req, res, () => {
    // If the middleware ignores the route, catch-all return 404
    res.status(404).json({ error: 'API endpoint not found or incorrect method.' });
  });
}
