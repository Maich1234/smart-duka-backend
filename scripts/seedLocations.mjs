/**
 * Seeds the Location collection (county/sub-county reference data) used by
 * onboarding's area picker and push-campaign location targeting. Idempotent
 * — safe to re-run; upserts on (country, type, name) so re-running after
 * adding new data for another country is just editing this file and
 * re-running, not a destructive reset.
 *
 * Kenya is fully seeded (47 counties + 301 sub-counties) from a verified
 * dataset (src/data/kenyaCounties.json, sourced from
 * github.com/Mondieki/kenya-counties-subcounties). The other East African
 * Community countries are seeded at country/region level only — no verified
 * sub-region dataset was available at the time this was written; add one
 * the same way Kenya's was added when a reliable source exists.
 *
 * Usage: node scripts/seedLocations.mjs
 */
import 'dotenv/config';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import mongoose from 'mongoose';
import Location from '../src/models/Location.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kenyaCounties = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../src/data/kenyaCounties.json'), 'utf8')
);

// Verified country/top-level-region data — see plan notes for sources.
// Uganda's district count (146+) is large and volatile; region-level only.
const REGION_ONLY_COUNTRIES = {
  UG: ['Central', 'Western', 'Eastern', 'Northern'],
  TZ: [
    'Arusha', 'Dar es Salaam', 'Dodoma', 'Geita', 'Iringa', 'Kagera', 'Katavi', 'Kigoma',
    'Kilimanjaro', 'Lindi', 'Manyara', 'Mara', 'Mbeya', 'Morogoro', 'Mtwara', 'Mwanza',
    'Njombe', 'Pwani', 'Rukwa', 'Ruvuma', 'Shinyanga', 'Simiyu', 'Singida', 'Songwe',
    'Tabora', 'Tanga', 'Mjini Magharibi', 'Kaskazini Unguja', 'Kusini Unguja',
    'Kaskazini Pemba', 'Kusini Pemba',
  ],
  RW: ['Kigali City', 'Northern Province', 'Southern Province', 'Eastern Province', 'Western Province'],
  // Post-March-2023 reorganization (down from 18 provinces) — verify before
  // trusting older/cached knowledge of Burundi's provinces.
  BI: ['Buhumuza', 'Bujumbura', 'Burunga', 'Butanyerera', 'Gitega'],
  // Post-2020-peace-agreement structure (reverted from the 2015 28-state split).
  SS: [
    'Central Equatoria', 'Eastern Equatoria', 'Jonglei', 'Lakes', 'Northern Bahr el Ghazal',
    'Unity', 'Upper Nile', 'Warrap', 'Western Bahr el Ghazal', 'Western Equatoria',
  ],
};

async function seedKenya() {
  let counties = 0;
  let subcounties = 0;

  for (const c of kenyaCounties) {
    const county = await Location.findOneAndUpdate(
      { country: 'KE', type: 'county', name: c.name },
      { $set: { code: String(c.code) } },
      { upsert: true, new: true }
    );
    counties += 1;

    for (const subName of c.sub_counties) {
      await Location.findOneAndUpdate(
        { country: 'KE', type: 'subcounty', name: subName, parentCounty: county._id },
        { $set: {} },
        { upsert: true }
      );
      subcounties += 1;
    }
  }

  console.log(`Kenya: ${counties} counties, ${subcounties} sub-counties.`);
}

async function seedRegionOnlyCountries() {
  for (const [country, names] of Object.entries(REGION_ONLY_COUNTRIES)) {
    for (const name of names) {
      await Location.findOneAndUpdate(
        { country, type: 'county', name },
        { $set: {} },
        { upsert: true }
      );
    }
    console.log(`${country}: ${names.length} regions.`);
  }
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  await seedKenya();
  await seedRegionOnlyCountries();
  const total = await Location.countDocuments();
  console.log(`Done. ${total} location documents total.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
