/**
 * Applies every schema-declared index to the database.
 *
 * Production runs with `autoIndex: false` (see src/config/db.js), because
 * leaving it on makes every serverless cold start re-issue createIndexes for
 * each model it touches. Index management moves here instead — run this as a
 * deploy step, or by hand after adding an index to a schema:
 *
 *   node scripts/syncIndexes.mjs           # additive: only creates what's missing
 *   node scripts/syncIndexes.mjs --prune   # also drops indexes no schema declares
 *
 * The additive default is deliberate: dropping an index is the one operation
 * here that can quietly degrade production, so it takes an explicit flag.
 */
import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';

const prune = process.argv.includes('--prune');
const MODELS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'models');

async function registerAllModels() {
  const files = (await readdir(MODELS_DIR)).filter((f) => f.endsWith('.js'));
  // Importing a model file is what registers its schema with mongoose.
  await Promise.all(files.map((f) => import(path.join(MODELS_DIR, f))));
  return files.length;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');

  // This script is the only thing that should touch indexes during its run.
  mongoose.set('autoIndex', false);

  const fileCount = await registerAllModels();
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected. Registered ${Object.keys(mongoose.models).length} models from ${fileCount} files.\n`);

  let created = 0;
  let dropped = 0;
  const failed = [];

  for (const [name, model] of Object.entries(mongoose.models)) {
    try {
      if (prune) {
        // syncIndexes() returns the names of indexes it dropped.
        const removed = await model.syncIndexes();
        if (removed.length) {
          dropped += removed.length;
          console.log(`${name}: dropped ${removed.join(', ')}`);
        }
      } else {
        await model.createIndexes();
      }
      const specs = model.schema.indexes().length;
      created += specs;
      console.log(`${name}: ${specs} index spec${specs === 1 ? '' : 's'} applied`);
    } catch (err) {
      // One bad model must not abandon the rest — a partially indexed
      // database is still better than an unindexed one, and the summary
      // below says exactly what to go fix.
      failed.push(`${name}: ${err.message}`);
      console.error(`${name}: FAILED — ${err.message}`);
    }
  }

  console.log(`\nDone. ${created} index specs applied${prune ? `, ${dropped} dropped` : ''}.`);
  if (failed.length) {
    console.error(`\n${failed.length} model(s) failed:\n  ${failed.join('\n  ')}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
