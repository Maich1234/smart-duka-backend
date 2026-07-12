import Location from '../models/Location.js';

/** GET /presets/counties?country=KE */
export const getCounties = async (req, res) => {
  const country = String(req.query.country || 'KE').toUpperCase();
  const counties = await Location.find({ country, type: 'county' }).sort({ name: 1 }).select('name code');
  res.json({ success: true, data: counties });
};

/** GET /presets/subcounties?county=<locationId> */
export const getSubcounties = async (req, res) => {
  const { county } = req.query;
  if (!county) {
    return res.status(400).json({ success: false, message: 'county is required' });
  }
  const subcounties = await Location.find({ type: 'subcounty', parentCounty: county }).sort({ name: 1 }).select('name');
  res.json({ success: true, data: subcounties });
};
