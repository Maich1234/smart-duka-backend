/**
 * Card payments — placeholder until a card processor is integrated.
 * Keeping the stub registered proves the provider interface and lets the
 * app list "Card (coming soon)" without special-casing.
 */
export default {
  key: 'card',
  label: 'Card',
  available: false,

  async charge() {
    const err = new Error('Card payments are coming soon. Please pay with M-PESA for now.');
    err.code = 'PROVIDER_UNAVAILABLE';
    throw err;
  },

  parseCallback() {
    throw new Error('Card payments are not yet supported');
  },
};
