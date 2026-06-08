const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const dataToValidate = req[property];
    const { error } = schema.validate(dataToValidate, { abortEarly: false });
    if (error) {
      const errors = error.details.map((detail) => detail.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors,
      });
    }
    next();
  };
};

export default validate;