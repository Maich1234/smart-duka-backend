import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import 'express-async-errors';
import connectDB from './config/db.js';
import routes from './routes/v1/index.js';
import errorHandler from './middlewares/errorHandler.js';
import { isOriginAllowed } from './middlewares/csrf.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Behind Vercel's proxy — required so express-rate-limit keys on the real
// client IP (X-Forwarded-For) instead of the proxy's.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Explicit options rather than bare helmet() so this stays byte-for-byte
// equivalent to the hand-rolled header block it replaces (DENY, not
// helmet's SAMEORIGIN default; no-referrer, not helmet's current default).
app.use(helmet({
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 15552000, includeSubDomains: true },
}));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Health check stays above the DB middleware so uptime probes don't open a
// Mongo connection.
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'DuQana API is running' });
});

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

// Explicit allowlist + credentials:true — required for cookie-based web
// sessions (a browser discards Set-Cookie from, and never sends cookies
// back to, a `*`-origin CORS response). isOriginAllowed (shared with the
// CSRF middleware, see csrf.js) falls back to allow-all in local dev when
// CORS_ALLOWED_ORIGINS is unset, but fails CLOSED in production — with
// cookie sessions live, reflecting an arbitrary Origin back with
// credentials:true would let any website a logged-in owner merely visits
// read their authenticated API responses.
app.use(cors({
  origin(origin, callback) {
    callback(null, isOriginAllowed(origin));
  },
  credentials: true,
}));

app.use(cookieParser());

// The Better Auth handler mounts here (app.all('/api/auth/*', ...)) once
// added — it needs the raw request stream, so it must precede the body
// parsers below.

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
// 1 MB cap — largest legitimate payload is a product with variants (~ a few
// KB); anything bigger is abuse or a client bug.
// rawBody is kept alongside the parsed body for Paystack's webhook signature
// check, which is an HMAC over the exact bytes Paystack sent — re-serializing
// req.body would not reliably reproduce that (key order, whitespace).
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/api/v1', routes);

app.use(errorHandler);

export default app;