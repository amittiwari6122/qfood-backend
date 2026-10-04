import { Router } from 'express';
import { body } from 'express-validator';
import Donation from '../models/Donation.js';
import { protect, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { upload } from '../middleware/upload.js';
import { storage } from '../services/storage/index.js';
import { analyzeFood } from '../services/ai/foodQuality.js';
import { evaluateDonation } from '../services/safety.js';
import { donationRisk } from '../services/fraud.js';
import { scheduleRematch } from '../services/quantum.js';
import { notify } from '../services/notify.js';
import { emitToRole } from '../services/socket.js';
import { AuditLog } from '../models/Misc.js';
import { ApiError, asyncHandler } from '../utils/http.js';

const r = Router();
r.use(protect);

// Form times are India local time (IST, +05:30); the server runs in UTC.
const dt = (date, time) => (date && time ? new Date(`${date}T${time}+05:30`) : date ? new Date(date) : undefined);

function statusFromAi(ai) {
  if (ai.status === 'UNSAFE') return 'REJECTED';
  if (ai.status === 'MANUAL_REVIEW') return 'AVAILABLE'; // admin review disabled
  return 'AVAILABLE';
}

r.post('/', authorize('DONOR'), upload.array('images', 4), validate([
  body('foodName').trim().notEmpty().withMessage('Enter the food name'),
  body('category').isIn(['cooked', 'bakery', 'produce', 'dairy', 'packaged', 'beverages', 'other']),
  body('isVeg').isBoolean().withMessage('Choose veg or non-veg'),
  body('quantity').isFloat({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('usableUntilDate').notEmpty().withMessage('Usable-until date is required'),
  body('usableUntilTime').notEmpty().withMessage('Usable-until time is required'),
  body('preparedDate').notEmpty(), body('preparedTime').notEmpty(),
  body('pickupStart').isISO8601().withMessage('Set a pickup start'), body('pickupEnd').isISO8601().withMessage('Set a pickup end'),
  body('address').trim().notEmpty(), body('lat').isFloat({ min: -90, max: 90 }), body('lng').isFloat({ min: -180, max: 180 }),
]), asyncHandler(async (req, res) => {
  if (req.user.verificationStatus === 'SUSPENDED') throw new ApiError(403, 'Your donor account is suspended');
  const b = req.body;
  const doc = {
    donor: req.user._id, foodName: b.foodName, category: b.category, foodType: b.foodType, isVeg: b.isVeg === 'true' || b.isVeg === true,
    quantity: +b.quantity, originalQuantity: +b.quantity, unit: b.unit || 'meals', peopleServed: +b.peopleServed || +b.quantity,
    preparedAt: dt(b.preparedDate, b.preparedTime), usableUntil: dt(b.usableUntilDate, b.usableUntilTime),
    pickupStart: new Date(b.pickupStart), pickupEnd: new Date(b.pickupEnd), address: b.address,
    location: { type: 'Point', coordinates: [+b.lng, +b.lat] }, storageCondition: b.storageCondition || 'room_temp',
    packaging: b.packaging, description: b.description,
    forSale: b.forSalePrice ? { enabled: true, price: +b.forSalePrice } : undefined,
  };
  const check = evaluateDonation(doc);
  if (!check.ok) throw new ApiError(400, check.reasons[0], check.reasons);

  const images = [];
  for (const f of req.files || []) images.push(await storage.save(f, 'food'));
  doc.images = images.map(({ url, publicId }) => ({ url, publicId }));

  doc.ai = images.length
    ? await analyzeFood(images[0].buffer, { foodName: doc.foodName, category: doc.category, storageCondition: doc.storageCondition })
    : { status: 'MANUAL_REVIEW', indicators: ['No photo uploaded'], recommendation: 'Add a photo, or an admin will review this donation.', provider: 'none', mode: 'no_image' };
  doc.status = statusFromAi(doc.ai);
  doc.manualReview = { required: doc.status === 'PENDING_REVIEW', status: doc.status === 'PENDING_REVIEW' ? 'PENDING' : 'NONE' };

  const flags = await donationRisk(req.user._id, doc);
  if (flags.length) doc.manualReview = { ...doc.manualReview, notes: `Risk flags: ${flags.join(', ')}` }; // flagged donations still go live

  const d = await Donation.create(doc);
  if (d.status === 'PENDING_REVIEW') emitToRole('ADMIN', 'review:new', { donationId: d._id });
  if (d.status === 'AVAILABLE') scheduleRematch('new donation');
  res.status(201).json(d);
}));

r.get('/mine', authorize('DONOR'), asyncHandler(async (req, res) => {
  res.json(await Donation.find({ donor: req.user._id }).populate('matchedNgo', 'name').sort('-createdAt'));
}));

r.get('/available', authorize('NGO', 'BENEFICIARY', 'ADMIN'), asyncHandler(async (req, res) => {
  const f = { status: 'AVAILABLE', usableUntil: { $gt: new Date() } };
  if (req.query.lat && req.query.lng) {
    f.location = { $near: { $geometry: { type: 'Point', coordinates: [+req.query.lng, +req.query.lat] }, $maxDistance: (+req.query.km || 25) * 1000 } };
  }
  res.json(await Donation.find(f).populate('donor', 'name city').limit(100));
}));

r.get('/review-queue', authorize('ADMIN'), asyncHandler(async (_req, res) => {
  res.json(await Donation.find({ status: 'PENDING_REVIEW' }).populate('donor', 'name email riskFlags verificationStatus').sort('usableUntil'));
}));

r.get('/:id', asyncHandler(async (req, res) => {
  const d = await Donation.findById(req.params.id).populate('donor', 'name city phone').populate('matchedNgo', 'name');
  if (!d) throw new ApiError(404, 'Donation not found');
  res.json(d);
}));

r.patch('/:id/review', authorize('ADMIN'), validate([body('decision').isIn(['APPROVED', 'REJECTED'])]), asyncHandler(async (req, res) => {
  const d = await Donation.findById(req.params.id);
  if (!d) throw new ApiError(404, 'Donation not found');
  d.manualReview = { required: true, status: req.body.decision, notes: req.body.notes };
  d.status = req.body.decision === 'APPROVED' ? (d.usableUntil > new Date() ? 'AVAILABLE' : 'EXPIRED') : 'REJECTED';
  await d.save();
  await AuditLog.create({ actor: req.user._id, action: `donation_review_${req.body.decision.toLowerCase()}`, entity: 'Donation', entityId: d._id, meta: { notes: req.body.notes } });
  await notify(d.donor, { type: 'review', title: `Donation ${req.body.decision.toLowerCase()}`, body: `${d.foodName}: ${req.body.notes || 'reviewed by admin'}`, link: '/app/donations' });
  if (d.status === 'AVAILABLE') scheduleRematch('donation approved');
  res.json(d);
}));

r.patch('/:id', authorize('DONOR'), asyncHandler(async (req, res) => {
  const d = await Donation.findOne({ _id: req.params.id, donor: req.user._id });
  if (!d) throw new ApiError(404, 'Donation not found');
  if (!['AVAILABLE', 'PENDING_REVIEW', 'MATCHED'].includes(d.status)) throw new ApiError(400, 'This donation can no longer be edited');
  if (req.body.quantity) d.quantity = Math.max(1, +req.body.quantity);
  if (req.body.usableUntil) {
    const u = new Date(req.body.usableUntil);
    if (u > d.usableUntil) throw new ApiError(400, 'Usable-until time can only be brought forward, not extended');
    d.usableUntil = u;
  }
  if (req.body.description !== undefined) d.description = req.body.description;
  const wasMatched = d.status === 'MATCHED';
  if (wasMatched) { await notify(d.matchedNgo, { type: 'match_changed', title: 'Matched donation changed', body: `${d.foodName} was updated; rematching.` }); d.status = 'AVAILABLE'; d.matchedNgo = undefined; d.matchedRequest = undefined; }
  await d.save();
  scheduleRematch('food quantity/time changed');
  res.json(d);
}));

r.post('/:id/cancel', authorize('DONOR', 'ADMIN'), asyncHandler(async (req, res) => {
  const q = { _id: req.params.id, ...(req.user.role === 'DONOR' ? { donor: req.user._id } : {}) };
  const d = await Donation.findOne(q);
  if (!d) throw new ApiError(404, 'Donation not found');
  if (['PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(d.status)) throw new ApiError(400, 'Food is already on its way');
  if (d.matchedNgo) await notify(d.matchedNgo, { type: 'cancelled', title: 'Donation cancelled', body: `${d.foodName} was cancelled by the donor.` });
  d.status = 'CANCELLED';
  await d.save();
  scheduleRematch('donation cancelled');
  res.json(d);
}));

export default r;
