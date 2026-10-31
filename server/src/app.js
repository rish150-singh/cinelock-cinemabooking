import './config/env.js';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import apiRoutes from './routes/apiRoutes.js';
import { HttpError } from './reservations.js';
import { setSeatChangeEmitter } from './seatEvents.js';

export { setSeatChangeEmitter };

export const app = express();

// -----------------------------------------------------------------------------
// App-wide middleware
// -----------------------------------------------------------------------------

app.use(helmet());
app.use(cors({
  origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

app.use('/api', rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false
}));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api', apiRoutes);

// -----------------------------------------------------------------------------
// Central error handling
// -----------------------------------------------------------------------------

app.use((error, _req, res, _next) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Invalid request',
      details: error.issues.map(issue => ({
        path: issue.path,
        message: issue.message
      }))
    });
  }

  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message });
  }

  if (error.code === 'P2023' || error.code === 'P2003') {
    return res.status(400).json({ error: 'Invalid movie or reservation identifier' });
  }

  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});
