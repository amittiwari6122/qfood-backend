import { Router } from 'express';
import { body } from 'express-validator';
import User from '../models/User.js';
import NgoProfile from '../models/NgoProfile.js';
import { AuditLog } from '../models/Misc.js';
import { protect, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { upload } from '../middleware/upload.js';
import { storage } from '../services/storage/index.js';
import { notify } from '../services/notify.js';
import { scheduleRematch } from '../services/quantum.js';
import { ApiError, asyncHandler } from '../utils/http.js';

const r = Router();
r.use(protect);

// ---- self-service profile ------------------------------------------------
r.patch('/me', upload.single('avatar'), validate([
  body('name').optional().trim().isLength({ min: 2, max: 80 }),
  body('phone').optional().matches(/^\+?[0-9]{10,14}$/),
  body('role').not().exists().withMessage('Role changes need an admin'),
  body('accountStatus').not().exists(), body('verificationStatus').not().exists(),
]), asyncHandler(async (req, res) => {
  const allowed = ['name', 'phone', 'address', 'city', 'language', 'vehicle'];
  for (const k of allowed) if (req.body[k] !== undefined) req.user[k] = req.body[k];
  if (req.body.lat && req.body.lng) req.user.location = { type: 'Point', coordinates: [+req.body.lng, +req.body.lat] };
  if (req.file) req.user.avatarUrl = (await storage.save(req.file, 'avatars')).url;
  await req.user.save();
  res.json({ user: req.user.toSafe() });
}));

r.patch('/me/availability', authorize('DELIVERY'), asyncHandler(async (req, res) => {
  req.user.available = !!req.body.available;
  if (req.body.capacity) req.user.deliveryCapacity = Math.max(1, Math.min(10, +req.body.capacity));
  await req.user.save();
  scheduleRematch(req.user.available ? 'delivery partner available' : 'delivery partner unavailable');
  res.json({ user: req.user.toSafe() });
}));

r.patch('/me/ngo', authorize('NGO'), upload.array('documents', 5), asyncHandler(async (req, res) => {
  const p = await NgoProfile.findOne({ user: req.user._id });
  for (const k of ['organizationName', 'registrationNumber', 'contactPerson', 'address']) if (req.body[k]) p[k] = req.body[k];
  for (const k of ['operatingAreas', 'foodRequirements']) if (req.body[k]) p[k] = [].concat(req.body[k]).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
  if (req.body.vegOnly !== undefined) p.vegOnly = req.body.vegOnly === 'true' || req.body.vegOnly === true;
  for (const f of req.files || []) p.documents.push({ url: (await storage.save(f, 'ngo-docs')).url, name: f.originalname });
  if (p.verificationStatus === 'REJECTED') p.verificationStatus = 'PENDING';
  await p.save();
  res.json({ ngo: p });
}));

// ---- admin management -----------------------------------------------------
r.get('/', authorize('ADMIN'), asyncHandler(async (req, res) => {
  const { role, status, verification, q } = req.query;
  const f = {};
  if (role) f.role = role;
  if (status) f.accountStatus = status;
  if (verification) f.verificationStatus = verification;
  if (q) f.$or = [{ name: new RegExp(q, 'i') }, { email: new RegExp(q, 'i') }];
  res.json(await User.find(f).sort('-createdAt').limit(200));
}));

r.patch('/:id/status', authorize('ADMIN'), validate([
  body('accountStatus').optional().isIn(['ACTIVE', 'PENDING_VERIFICATION', 'REVIEW_REQUIRED', 'SUSPENDED', 'BLOCKED']),
  body('verificationStatus').optional().isIn(['PENDING', 'VERIFIED', 'REVIEW_REQUIRED', 'REJECTED', 'SUSPENDED']),
  body('role').optional().isIn(['DONOR', 'NGO', 'BENEFICIARY', 'DELIVERY', 'ADMIN']),
]), asyncHandler(async (req, res) => {
  const u = await User.findById(req.params.id);
  if (!u) throw new ApiError(404, 'User not found');
  if (u._id.equals(req.user._id) && req.body.role) throw new ApiError(400, 'You cannot change your own role');
  const before = { accountStatus: u.accountStatus, verificationStatus: u.verificationStatus, role: u.role };
  for (const k of ['accountStatus', 'verificationStatus', 'role']) if (req.body[k]) u[k] = req.body[k];
  await u.save();
  await AuditLog.create({ actor: req.user._id, action: 'user_status', entity: 'User', entityId: u._id, meta: { before, after: req.body, note: req.body.note }, ip: req.ip });
  await notify(u._id, { type: 'account', title: 'Account updated', body: `Status: ${u.accountStatus}, verification: ${u.verificationStatus}` });
  scheduleRematch('participant status changed');
  res.json(u);
}));

// ---- NGO verification -----------------------------------------------------
r.get('/ngos', authorize('ADMIN'), asyncHandler(async (req, res) => {
  const f = req.query.status ? { verificationStatus: req.query.status } : {};
  res.json(await NgoProfile.find(f).populate('user', 'name email phone city accountStatus').sort('-createdAt'));
}));

r.patch('/ngos/:id/verify', authorize('ADMIN'), validate([
  body('action').isIn(['APPROVE', 'REJECT', 'REQUEST_REVIEW', 'SUSPEND']),
]), asyncHandler(async (req, res) => {
  const map = { APPROVE: 'VERIFIED', REJECT: 'REJECTED', REQUEST_REVIEW: 'REVIEW_REQUIRED', SUSPEND: 'SUSPENDED' };
  const p = await NgoProfile.findById(req.params.id);
  if (!p) throw new ApiError(404, 'NGO not found');
  p.verificationStatus = map[req.body.action];
  p.verificationNotes = req.body.notes;
  p.verifiedBy = req.user._id; p.verifiedAt = new Date();
  await p.save();
  await User.updateOne({ _id: p.user }, { verificationStatus: p.verificationStatus, ...(req.body.action === 'SUSPEND' ? { accountStatus: 'SUSPENDED' } : {}) });
  await AuditLog.create({ actor: req.user._id, action: `ngo_${req.body.action.toLowerCase()}`, entity: 'NgoProfile', entityId: p._id, meta: { notes: req.body.notes }, ip: req.ip });
  await notify(p.user, { type: 'verification', title: `NGO verification: ${p.verificationStatus.replace('_', ' ').toLowerCase()}`, body: req.body.notes || '', link: '/app/profile' });
  scheduleRematch('NGO verification changed');
  res.json(p);
}));

r.get('/audit', authorize('ADMIN'), asyncHandler(async (_req, res) => {
  res.json(await AuditLog.find().populate('actor', 'name role').sort('-createdAt').limit(200));
}));

export default r;
