import { Router } from 'express';
import { body } from 'express-validator';
import rateLimit from 'express-rate-limit';
import User, { PUBLIC_ROLES } from '../models/User.js';
import NgoProfile from '../models/NgoProfile.js';
import { AuditLog } from '../models/Misc.js';
import { protect, signToken } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { upload } from '../middleware/upload.js';
import { storage } from '../services/storage/index.js';
import { registrationRisk } from '../services/fraud.js';
import { sendSms, makeOtp, hashOtp } from '../services/external.js';
import { ApiError, asyncHandler } from '../utils/http.js';
import env from '../config/env.js';

const r = Router();
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const PHONE = /^\+?[0-9]{10,14}$/;

/** Verification removed: every non-blocked account is active + verified so matching works immediately. */
async function autoVerify(user) {
  if (['BLOCKED', 'SUSPENDED'].includes(user.accountStatus)) return user;
  let changed = false;
  if (user.accountStatus !== 'ACTIVE') { user.accountStatus = 'ACTIVE'; changed = true; }
  if (user.verificationStatus !== 'VERIFIED') { user.verificationStatus = 'VERIFIED'; changed = true; }
  if (!user.phoneVerified) { user.phoneVerified = true; changed = true; }
  if (user.role === 'DELIVERY' && user.available === false) { user.available = true; changed = true; }
  if (changed) await user.save();
  if (user.role === 'NGO') await NgoProfile.updateOne({ user: user._id, verificationStatus: { $ne: 'VERIFIED' } }, { verificationStatus: 'VERIFIED' });
  return user;
}

async function issueOtp(user, purpose) {
  const code = makeOtp();
  user.otp = { codeHash: hashOtp(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000), purpose, attempts: 0 };
  await user.save();
  await sendSms(user.phone, `Your FoodBridge code is ${code}. It expires in 10 minutes.`);
  return env.nodeEnv === 'development' ? { devOtp: code } : {};
}

r.post('/register', authLimiter, upload.single('avatar'), validate([
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Enter your full name'),
  body('email').isEmail().withMessage('Enter a valid email').normalizeEmail(),
  body('phone').matches(PHONE).withMessage('Enter a valid phone number (10–14 digits)'),
  body('password').isStrongPassword({ minLength: 8, minSymbols: 0 }).withMessage('Password needs 8+ characters with upper, lower case and a number'),
  body('confirmPassword').custom((v, { req }) => v === req.body.password).withMessage('Passwords do not match'),
  body('role').isIn(PUBLIC_ROLES).withMessage('Choose a valid role'),
  body('acceptTerms').equals('true').withMessage('Accept the terms to continue'),
  body('city').trim().notEmpty().withMessage('Enter your city'),
  body('organizationName').if(body('role').equals('NGO')).notEmpty().withMessage('Enter your organisation name'),
  body('registrationNumber').if(body('role').equals('NGO')).notEmpty().withMessage('Enter your NGO registration number'),
]), asyncHandler(async (req, res) => {
  const { name, email, phone, password, role, address, city, lat, lng } = req.body;
  if (await User.exists({ email })) throw new ApiError(409, 'An account with this email already exists');
  const risk = await registrationRisk({ email, phone }, req.ip);
  const user = new User({ name, email, phone, password, role, address, city,
    location: lat && lng ? { type: 'Point', coordinates: [+lng, +lat] } : undefined,
    accountStatus: 'ACTIVE', riskFlags: risk.flags, riskScore: risk.score });
  if (req.file) user.avatarUrl = (await storage.save(req.file, 'avatars')).url;
  await user.save();
  if (role === 'NGO') {
    await NgoProfile.create({ user: user._id, organizationName: req.body.organizationName, registrationNumber: req.body.registrationNumber,
      contactPerson: name, phone, email, address, operatingAreas: city ? [city] : [] });
  }
  await AuditLog.create({ actor: user._id, action: 'register', entity: 'User', entityId: user._id, meta: risk, ip: req.ip });
  // Phone OTP step removed: mark phone as verified automatically.
  await autoVerify(user);
  res.status(201).json({ token: signToken(user), user: user.toSafe() });
}));

r.post('/login', authLimiter, validate([body('email').isEmail().normalizeEmail(), body('password').notEmpty()]), asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.body.email }).select('+password');
  if (!user) throw new ApiError(401, 'Email or password is incorrect');
  if (user.lockUntil && user.lockUntil > new Date()) throw new ApiError(423, 'Too many attempts. Try again in 15 minutes.');
  if (!(await user.comparePassword(req.body.password))) {
    user.failedLogins += 1;
    if (user.failedLogins >= 5) { user.lockUntil = new Date(Date.now() + 15 * 60 * 1000); user.failedLogins = 0; }
    await user.save();
    throw new ApiError(401, 'Email or password is incorrect');
  }
  if (user.accountStatus === 'BLOCKED') throw new ApiError(403, 'This account is blocked');
  user.failedLogins = 0; user.lockUntil = undefined; user.lastLogin = new Date();
  await user.save();
  await autoVerify(user);
  res.json({ token: signToken(user), user: user.toSafe() });
}));

r.get('/me', protect, asyncHandler(async (req, res) => {
  await autoVerify(req.user);
  const ngo = req.user.role === 'NGO' ? await NgoProfile.findOne({ user: req.user._id }) : null;
  res.json({ user: req.user.toSafe(), ngo });
}));

r.post('/otp/send', protect, asyncHandler(async (req, res) => res.json({ sent: true, ...(await issueOtp(req.user, 'verify_phone')) })));

r.post('/otp/verify', protect, validate([body('code').isLength({ min: 6, max: 6 })]), asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+otp.codeHash');
  if (!user.otp?.codeHash || user.otp.expiresAt < new Date()) throw new ApiError(400, 'Code expired. Request a new one.');
  if (user.otp.attempts >= 5) throw new ApiError(429, 'Too many wrong codes. Request a new one.');
  if (hashOtp(req.body.code) !== user.otp.codeHash) { user.otp.attempts += 1; await user.save(); throw new ApiError(400, 'Incorrect code'); }
  user.phoneVerified = true; user.otp = undefined;
  // Donors and beneficiaries are verified by phone unless risk checks flagged them.
  if (['DONOR', 'BENEFICIARY'].includes(user.role) && !user.riskFlags.length) user.verificationStatus = 'VERIFIED';
  await user.save();
  res.json({ user: user.toSafe() });
}));

r.post('/password/forgot', authLimiter, validate([body('email').isEmail().normalizeEmail()]), asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  const extra = user ? await issueOtp(user, 'reset_password') : {};
  res.json({ message: 'If that email exists, a reset code was sent to the registered phone.', ...extra });
}));

r.post('/password/reset', authLimiter, validate([
  body('email').isEmail().normalizeEmail(), body('code').isLength({ min: 6, max: 6 }),
  body('password').isStrongPassword({ minLength: 8, minSymbols: 0 }).withMessage('Password needs 8+ characters with upper, lower case and a number'),
]), asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.body.email }).select('+otp.codeHash');
  if (!user || user.otp?.purpose !== 'reset_password' || user.otp.expiresAt < new Date() || hashOtp(req.body.code) !== user.otp.codeHash) throw new ApiError(400, 'Invalid or expired code');
  user.password = req.body.password; user.otp = undefined;
  await user.save();
  res.json({ message: 'Password updated. Sign in with your new password.' });
}));

export default r;
