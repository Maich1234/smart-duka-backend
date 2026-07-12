import mongoose from 'mongoose';

// County/sub-county reference data, seeded via scripts/seedLocations.mjs.
// Country selection itself already comes from the static COUNTRIES list in
// constants/presets.js — this only covers the layer underneath it. A single
// self-referential collection (rather than separate County/SubCounty
// models) keeps seeding and querying simple across countries that currently
// only have county-level data seeded (everything but Kenya, for now).
const locationSchema = new mongoose.Schema({
  type: { type: String, enum: ['county', 'subcounty'], required: true },
  // Matches constants/presets.js's VALID_COUNTRY_CODES, e.g. 'KE'.
  country: { type: String, required: true, uppercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  // Official code where one exists (Kenya's counties have them); optional elsewhere.
  code: { type: String, default: null },
  // Set only when type === 'subcounty'.
  parentCounty: { type: mongoose.Schema.Types.ObjectId, ref: 'Location', default: null },
}, { timestamps: true });

locationSchema.index({ country: 1, type: 1 });
locationSchema.index({ parentCounty: 1 });
locationSchema.index({ country: 1, type: 1, name: 1 }, { unique: true });

export default mongoose.model('Location', locationSchema);
