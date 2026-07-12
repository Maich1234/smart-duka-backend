/**
 * Bootstraps a SmartDuka internal admin account. There is no self-serve
 * admin registration by design — this is the only way to create one.
 *
 * Usage:
 *   node scripts/createAdminUser.mjs --email a@smartduka.co --password ... --name "Ada Owner"
 *   node scripts/createAdminUser.mjs --email a@smartduka.co --password ... --name "Ada" --force   # reset password on an existing email
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

async function main() {
  if (!email || !password || !name) {
    throw new Error('Usage: node scripts/createAdminUser.mjs --email <email> --password <password> --name <name> [--force]');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
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
    await existing.save();
    console.log(`Password reset for existing admin "${email}".`);
    return;
  }

  await AdminUser.create({ email, password, name });
  console.log(`Admin account created: ${email}`);
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
