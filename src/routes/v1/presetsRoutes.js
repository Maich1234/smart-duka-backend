import express from 'express';
import { COUNTRIES, CURRENCIES, UNITS_OF_MEASURE } from '../../constants/presets.js';

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

export default router;
