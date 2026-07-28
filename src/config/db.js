import mongoose from 'mongoose';

// Must be set before any model/schema is created so all schemas inherit it.
// Passing bufferCommands in connect() options only applies to the connection
// object, not to schemas already instantiated at import time.
mongoose.set('bufferCommands', false);

// Index builds are a development convenience, not a deploy step. Left on (the
// mongoose default), every cold start re-issues createIndexes for every model
// it touches — pure latency and Atlas load on a platform that cold-starts
// constantly. Indexes are declared on the schemas and applied by
// `npm run sync-indexes` at deploy time instead.
mongoose.set('autoIndex', process.env.NODE_ENV !== 'production');

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
      // A serverless instance handles one request at a time, so a large pool
      // buys nothing and costs the only resource that is actually scarce:
      // Atlas connection slots. The driver default is 100 *per instance* —
      // 15 concurrent warm lambdas would exhaust an M10's 1500-connection
      // cap before any query became the bottleneck. A few spare sockets
      // cover the parallel Promise.all reads the controllers do.
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 5,
      minPoolSize: 0,
      // Reap sockets left over from instances Vercel has already frozen,
      // rather than holding slots open until the server times them out.
      maxIdleTimeMS: 60_000,
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