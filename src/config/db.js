import mongoose from 'mongoose';

// Must be set before any model/schema is created so all schemas inherit it.
// Passing bufferCommands in connect() options only applies to the connection
// object, not to schemas already instantiated at import time.
mongoose.set('bufferCommands', false);

let cached = global._mongooseCache;

if (!cached) {
  cached = global._mongooseCache = { conn: null, promise: null };
}

const connectDB = async () => {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }

  // Stale connection (cached but socket dropped) — force reconnect
  if (cached.conn) {
    cached.conn = null;
    cached.promise = null;
  }

  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 8000,
    });
  }

  try {
    cached.conn = await cached.promise;
    console.log(`MongoDB Connected: ${cached.conn.connection.host}`);
  } catch (error) {
    cached.promise = null;
    console.error(`Error connecting to db: ${error.message}`);
    throw error;
  }

  return cached.conn;
};

export default connectDB;