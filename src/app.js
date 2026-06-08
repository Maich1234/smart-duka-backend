import express from 'express';
import cors from 'cors';
import 'express-async-errors';
import connectDB from './config/db.js';
import routes from './routes/v1/index.js';
import errorHandler from './middlewares/errorHandler.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use('/api/v1', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Smart Duka API is running' });
});

// Error handling middleware (should be last)
app.use(errorHandler);

export default app;