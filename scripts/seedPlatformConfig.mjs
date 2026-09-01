/**
 * One-time bootstrap for DuQana's platform-level M-Pesa credentials —
 * the Daraja account that COLLECTS subscription payments.
 *
 * Copies the encrypted mpesa config from an existing shop's paymentconfigs
 * document (both sides use the same ENCRYPTION_KEY, so the ciphertext copies
 * verbatim) into the PlatformConfig singleton. Idempotent: refuses to
 * overwrite an already-configured platform unless --force is passed.
 *
 * Usage:
 *   node scripts/seedPlatformConfig.mjs                 # copy from the only configured shop
 *   node scripts/seedPlatformConfig.mjs --shop <name>   # pick a shop by name
 *   node scripts/seedPlatformConfig.mjs --force         # overwrite existing platform config
 *
 * Later this is managed from the super-admin page instead.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import PaymentConfig from '../src/models/PaymentConfig.js';
import PlatformConfig from '../src/models/PlatformConfig.js';
import Shop from '../src/models/Shop.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const shopNameIdx = args.indexOf('--shop');
const shopName = shopNameIdx !== -1 ? args[shopNameIdx + 1] : null;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const platform = await PlatformConfig.get();
  if (platform.mpesa?.enabled && !force) {
    console.log('Platform M-Pesa is already configured (shortcode ' + platform.mpesa.shortcode + ', ' + platform.mpesa.environment + '). Use --force to overwrite.');
    return;
  }

  let query = {};
  if (shopName) {
    const shop = await Shop.findOne({ name: new RegExp(`^${shopName}$`, 'i') });
    if (!shop) throw new Error(`No shop named "${shopName}" found`);
    query = { shop: shop._id };
  }

  const sources = await PaymentConfig.find({ ...query, 'mpesa.enabled': true });
  if (sources.length === 0) {
    throw new Error('No enabled shop M-Pesa config found to copy from. Configure one in the app first, or insert the platform credentials directly.');
  }
  if (sources.length > 1 && !shopName) {
    const names = await Promise.all(sources.map(async (s) => (await Shop.findById(s.shop))?.name ?? String(s.shop)));
    throw new Error(`Multiple shops have M-Pesa configured (${names.join(', ')}). Re-run with --shop <name> to pick the source.`);
  }

  const source = sources[0];
  const sourceShop = await Shop.findById(source.shop);

  platform.mpesa = {
    enabled: true,
    environment: source.mpesa.environment,
    businessName: 'DuQana',
    shortcode: source.mpesa.shortcode,
    consumerKey: source.mpesa.consumerKey,
    consumerSecret: source.mpesa.consumerSecret,
    passkey: source.mpesa.passkey,
    configuredAt: new Date(),
  };
  await platform.save();

  console.log(`Platform M-Pesa configured from shop "${sourceShop?.name}" — shortcode ${platform.mpesa.shortcode} (${platform.mpesa.environment}).`);
  console.log(`Grace period: ${platform.gracePeriodDays} days · reminders at T-${platform.reminderDaysBefore.join('d, T-')}d.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
