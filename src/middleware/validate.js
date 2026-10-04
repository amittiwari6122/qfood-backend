import { validationResult } from 'express-validator';
import { ApiError } from '../utils/http.js';

export const validate = (rules) => [...rules, (req, _res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();
  next(new ApiError(400, errors.array()[0].msg, errors.array()));
}];
