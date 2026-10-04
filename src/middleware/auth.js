import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import User from '../models/User.js';
import { ApiError, asyncHandler } from '../utils/http.js';

export const signToken = (user) => jwt.sign({ sub: user._id.toString(), role: user.role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

export const protect = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new ApiError(401, 'Sign in to continue');
  let payload;
  try { payload = jwt.verify(token, env.jwtSecret); } catch { throw new ApiError(401, 'Session expired. Sign in again.'); }
  const user = await User.findById(payload.sub);
  if (!user) throw new ApiError(401, 'Account no longer exists');
  if (['SUSPENDED', 'BLOCKED'].includes(user.accountStatus)) throw new ApiError(403, `Account ${user.accountStatus.toLowerCase()}`);
  req.user = user;
  next();
});

/** RBAC: authorize('DONOR','ADMIN') */
export const authorize = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) return next(new ApiError(403, `This action needs role: ${roles.join(' or ')}`));
  next();
};

/** Blocks actions until admin verification is done (e.g. NGO accepting food). */
export const requireVerified = (req, _res, next) => {
  if (req.user.role === 'ADMIN' || req.user.verificationStatus === 'VERIFIED') return next();
  next(new ApiError(403, 'Your account must be verified by an admin first'));
};
