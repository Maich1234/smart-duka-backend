/**
 * Bootstraps a DuQana internal admin account. Most accounts are now
 * created via the admin-management API (super_admin only, see
 * adminManagementController.js); this script remains as a break-glass
 * bootstrap path independent of the API/DB app layer — e.g. for creating
 * the first super_admin, or recovering if every super_admin is locked out.
 *
 * Usage:
 *   node scripts/createAdminUser.mjs --email a@dukana.co --password ... --name "Ada Owner" [--role super_admin] [--permissions plans,shops]
 *   node scripts/createAdminUser.mjs --email a@dukana.co --password ... --name "Ada" --force   # reset password on an existing email
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import AdminUser from '../src/models/AdminUser.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const flag = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
};

const email = flag('email');
const password = flag('password');
const name = flag('name');
const roleFlag = flag('role');
const permissionsFlag = flag('permissions');
const role = roleFlag || 'admin';
const permissions = permissionsFlag ? permissionsFlag.split(',').map((p) => p.trim()).filter(Boolean) : [];

async function main() {
  if (!email || !password || !name) {
    throw new Error('Usage: node scripts/createAdminUser.mjs --email <email> --password <password> --name <name> [--role super_admin|admin] [--permissions a,b] [--force]');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  if (role !== 'super_admin' && role !== 'admin') {
    throw new Error('--role must be "super_admin" or "admin".');
  }

  await mongoose.connect(process.env.MONGO_URI);

  const existing = await AdminUser.findOne({ email: email.toLowerCase() });
  if (existing && !force) {
    console.log(`Admin "${email}" already exists. Use --force to reset their password.`);
    return;
  }

  if (existing) {
    existing.password = password;
    existing.name = name;
    existing.active = true;
    // Only touch role/permissions if explicitly passed — a plain password
    // reset shouldn't silently change an existing admin's access.
    if (roleFlag) existing.role = role;
    if (permissionsFlag) existing.permissions = permissions;
    await existing.save();
    console.log(`Password reset for existing admin "${email}".`);
    return;
  }

  await AdminUser.create({ email, password, name, role, permissions });
  console.log(`Admin account created: ${email} (role: ${role})`);
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
