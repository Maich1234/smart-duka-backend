import express from 'express';
import cors from 'cors';
import 'express-async-errors';
import connectDB from './config/db.js';
import routes from './routes/v1/index.js';
import errorHandler from './middlewares/errorHandler.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

connectDB();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/v1', routes);

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Smart Duka API is running' });
});

app.use(errorHandler);

export default app;