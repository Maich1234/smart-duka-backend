const validate = (schema, property = 'body') => {
  
  return (req, res, next) => {
    const dataToValidate = req[property];
    const { error, value } = schema.validate(dataToValidate, { abortEarly: false, stripUnknown: true });
    if (error) {
      const errors = error.details.map((detail) => detail.message);
      // Alongside `errors` (kept as plain strings for existing consumers,
      // e.g. services/shifts.ts on mobile matches against that shape), give
      // clients a field-addressable version so a form can show each message
      // under its own input instead of one generic banner/toast.
      const fieldErrors = error.details.map((detail) => ({
        field: detail.path[0],
        message: detail.message.replace(/^"[^"]+"\s*/, ''),
      }));
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors,
        fieldErrors,
      });
    }
    req[property] = value;
    next();
  };
};

export default validate;