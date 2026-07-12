import express from 'express';
import { COUNTRIES, CURRENCIES, UNITS_OF_MEASURE } from '../../constants/presets.js';
import { getCounties, getSubcounties } from '../../controllers/presetsController.js';

const router = express.Router();

// Public — no auth needed. Returns lookup tables for dropdowns.
router.get('/', (_req, res) => {
  res.json({
    success: true,
    data: {
      countries: COUNTRIES,
      currencies: CURRENCIES,
      unitsOfMeasure: UNITS_OF_MEASURE,
    },
  });
});

// DB-backed (see Location model) — seeded via scripts/seedLocations.mjs.
router.get('/counties', getCounties);
router.get('/subcounties', getSubcounties);

export default router;
