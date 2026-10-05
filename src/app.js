import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'path';
import env from './config/env.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import donationRoutes from './routes/donations.js';
import requestRoutes from './routes/requests.js';
import quantumRoutes from './routes/quantum.js';
import deliveryRoutes from './routes/deliveries.js';
import wasteRoutes from './routes/waste.js';
import socialRoutes from './routes/social.js';
import analyticsRoutes from './routes/analytics.js';
import { notFound, errorHandler } from './middleware/error.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: env.clientUrl, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
if (env.nodeEnv !== 'test') app.use(morgan('dev'));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/uploads', express.static(path.resolve('uploads'), { maxAge: '7d' }));

// API gateway
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date() }));
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/donations', donationRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/quantum', quantumRoutes);
app.use('/api/deliveries', deliveryRoutes);
app.use('/api/waste', wasteRoutes);
app.use('/api', socialRoutes);
app.use('/api/analytics', analyticsRoutes);

app.use(notFound);
app.use(errorHandler);
export default app;
