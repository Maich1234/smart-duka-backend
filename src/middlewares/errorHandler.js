const DUPLICATE_KEY_MESSAGES = {
  email: 'An account with this email address already exists.',
  'shop + idempotencyKey': 'This payment request was already sent. Please wait for the customer to enter their PIN.',
  idempotencyKey: 'This payment request was already sent. Please wait for the customer to enter their PIN.',
  checkoutRequestId: 'A payment with this reference already exists.',
  phone: 'This phone number is already registered.',
  name: 'A record with this name already exists.',
};

const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

  if (err.code === 11000) {
    const keys = Object.keys(err.keyPattern);
    const lookupKey = keys.length === 1 ? keys[0] : keys.join(' + ');
    const message = DUPLICATE_KEY_MESSAGES[lookupKey] ?? 'This record already exists. Please check your details and try again.';
    return res.status(409).json({ success: false, message });
  }

  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      success: false,
      message: 'Some information is missing or incorrect. Please check the form and try again.',
      errors,
    });
  }

  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: 'The requested item could not be found. It may have been deleted or the link is invalid.',
    });
  }

  const status = err.status || 500;
  // Unexpected 500s can carry internals (driver errors, stack fragments) in
  // err.message — never forward those to clients in production. Errors thrown
  // with an explicit status are operational and their messages are user-safe.
  const exposeMessage = err.status || process.env.NODE_ENV !== 'production';
  res.status(status).json({
    success: false,
    message: (exposeMessage && err.message) || 'Something went wrong on our end. Please try again or contact support.',
  });
};

export default errorHandler;
