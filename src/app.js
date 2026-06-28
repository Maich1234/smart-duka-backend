import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import 'express-async-errors';
import connectDB from './config/db.js';
import routes from './routes/v1/index.js';
import errorHandler from './middlewares/errorHandler.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable' });
  }
});

app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/v1', routes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Smart Duka API is running' });
});

app.use(errorHandler);

export default app;