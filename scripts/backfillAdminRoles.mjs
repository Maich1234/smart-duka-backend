/**
 * One-shot backfill for the two AdminUser docs created before role/permissions
 * existed on the schema. Run once by hand against production:
 *   node scripts/backfillAdminRoles.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import AdminUser from '../src/models/AdminUser.js';
import { ADMIN_PERMISSION_VALUES } from '../src/constants/adminPermissions.js';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // NB: this address is a literal lookup key for a row that already exists in
  // production, created before the Dukana rename. It is deliberately NOT
  // renamed — changing it makes this query match nothing and the backfill
  // silently no-ops. Same reason `admin@wabunifu.com` below stays as-is.
  const superAdminResult = await AdminUser.updateOne(
    { email: 'super-admin@smartduka.com' },
    { $set: { role: 'super_admin', permissions: [] } }
  );
  console.log(
    'super-admin@smartduka.com ->',
    superAdminResult.matchedCount ? 'updated' : 'not found'
  );

  const adminResult = await AdminUser.updateOne(
    { email: 'admin@wabunifu.com' },
    { $set: { role: 'admin', permissions: ADMIN_PERMISSION_VALUES } }
  );
  console.log('admin@wabunifu.com ->', adminResult.matchedCount ? 'updated' : 'not found');
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
