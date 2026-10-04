export function notFound(req, res) { res.status(404).json({ message: `Not found: ${req.originalUrl}` }); }

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let status = err.status || 500;
  let message = err.message || 'Server error';
  if (err.name === 'ValidationError') { status = 400; message = Object.values(err.errors).map((e) => e.message).join(', '); }
  if (err.code === 11000) { status = 409; message = `${Object.keys(err.keyValue || {}).join(', ')} already in use`; }
  if (err.name === 'CastError') { status = 400; message = `Invalid ${err.path}`; }
  if (err.name === 'MulterError') { status = 400; }
  if (status >= 500) console.error(err);
  res.status(status).json({ message, details: err.details });
}
