import { initializeApp, cert, getApps } from 'firebase-admin/app';

let app;

/**
 * Lazily initializes the Firebase Admin app on first use so the server can
 * still boot (and non-push routes still work) before FIREBASE_* env vars
 * are configured.
 */
export const getFirebaseAdmin = () => {
  if (app) return app;
  if (getApps().length) {
    app = getApps()[0];
    return app;
  }

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error('Firebase Admin is not configured (missing FIREBASE_* env vars)');
  }

  app = initializeApp({
    credential: cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      // .env stores literal "\n" sequences; convert back to real newlines
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });

  return app;
};

export const isFirebaseConfigured = () =>
  Boolean(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
