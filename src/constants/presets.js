// Static presets — countries, currencies, and units of measure.
// Served via GET /api/v1/presets (no auth required).

export const COUNTRIES = [
  { code: 'KE', name: 'Kenya',       currency: 'KES', currencyName: 'Kenyan Shilling',          symbol: 'KSh', phonePrefix: '+254', flag: '🇰🇪' },
  { code: 'UG', name: 'Uganda',      currency: 'UGX', currencyName: 'Ugandan Shilling',          symbol: 'USh', phonePrefix: '+256', flag: '🇺🇬' },
  { code: 'TZ', name: 'Tanzania',    currency: 'TZS', currencyName: 'Tanzanian Shilling',        symbol: 'TSh', phonePrefix: '+255', flag: '🇹🇿' },
  { code: 'RW', name: 'Rwanda',      currency: 'RWF', currencyName: 'Rwandan Franc',             symbol: 'RF',  phonePrefix: '+250', flag: '🇷🇼' },
  { code: 'ET', name: 'Ethiopia',    currency: 'ETB', currencyName: 'Ethiopian Birr',            symbol: 'Br',  phonePrefix: '+251', flag: '🇪🇹' },
  { code: 'BI', name: 'Burundi',     currency: 'BIF', currencyName: 'Burundian Franc',           symbol: 'Fr',  phonePrefix: '+257', flag: '🇧🇮' },
  { code: 'SS', name: 'South Sudan', currency: 'SSP', currencyName: 'South Sudanese Pound',      symbol: '£',   phonePrefix: '+211', flag: '🇸🇸' },
  { code: 'US', name: 'United States', currency: 'USD', currencyName: 'US Dollar',              symbol: '$',   phonePrefix: '+1',   flag: '🇺🇸' },
];

export const CURRENCIES = COUNTRIES.map(({ currency, currencyName, symbol, flag }) => ({
  code: currency,
  name: currencyName,
  symbol,
  flag,
}));

export const VALID_CURRENCY_CODES = CURRENCIES.map((c) => c.code);
export const VALID_COUNTRY_CODES  = COUNTRIES.map((c) => c.code);

export const UNITS_OF_MEASURE = [
  { value: 'unit',   label: 'Unit / Piece',  abbreviation: 'unit' },
  { value: 'kg',     label: 'Kilogram',       abbreviation: 'kg'   },
  { value: 'g',      label: 'Gram',           abbreviation: 'g'    },
  { value: 'l',      label: 'Litre',          abbreviation: 'L'    },
  { value: 'ml',     label: 'Millilitre',     abbreviation: 'mL'   },
  { value: 'dozen',  label: 'Dozen',          abbreviation: 'doz'  },
  { value: 'pack',   label: 'Pack',           abbreviation: 'pk'   },
  { value: 'box',    label: 'Box',            abbreviation: 'box'  },
  { value: 'bag',    label: 'Bag',            abbreviation: 'bag'  },
  { value: 'lb',     label: 'Pound',          abbreviation: 'lb'   },
  { value: 'oz',     label: 'Ounce',          abbreviation: 'oz'   },
  { value: 'm',      label: 'Metre',          abbreviation: 'm'    },
  { value: 'cm',     label: 'Centimetre',     abbreviation: 'cm'   },
  { value: 'ton',    label: 'Tonne',          abbreviation: 't'    },
];

export const VALID_UNITS = UNITS_OF_MEASURE.map((u) => u.value);
