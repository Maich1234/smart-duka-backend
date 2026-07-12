/**
 * Bank transfer payments — placeholder until bank rails are integrated.
 */
export default {
  key: 'bank',
  label: 'Bank transfer',
  available: false,

  async charge() {
    const err = new Error('Bank payments are coming soon. Please pay with M-PESA for now.');
    err.code = 'PROVIDER_UNAVAILABLE';
    throw err;
  },

  parseCallback() {
    throw new Error('Bank payments are not yet supported');
  },
};
