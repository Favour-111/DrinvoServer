import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import { env } from './config/env.js';
import { apiLimiter } from './middleware/rateLimiters.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { UPLOAD_DIR } from './middleware/upload.js';
import api from './routes/index.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin(origin, cb) {
        // Allow same-origin tools (curl, server-to-server) and listed frontends
        if (!origin || env.clientUrls.includes(origin)) return cb(null, true);
        cb(new Error('Origin not allowed by CORS'));
      },
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Shop-Id'],
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    })
  );
  app.use(express.json({ limit: '200kb' }));
  app.use(mongoSanitize());
  if (!env.isProd) app.use(morgan('dev'));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', fallthrough: false }));
  app.use('/api', apiLimiter, api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
