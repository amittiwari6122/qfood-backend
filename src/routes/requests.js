import { Router } from 'express';
import { body } from 'express-validator';
import FoodRequest from '../models/FoodRequest.js';
import { protect, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { scheduleRematch } from '../services/quantum.js';
import { ApiError, asyncHandler } from '../utils/http.js';

const r = Router();
r.use(protect);

r.post('/', authorize('NGO', 'BENEFICIARY'), validate([
  body('foodRequired').trim().notEmpty().withMessage('Describe the food you need'),
  body('quantity').isFloat({ min: 1 }), body('beneficiaries').isInt({ min: 1 }),
  body('requiredBefore').isISO8601().withMessage('Required-before date and time is mandatory')
    .custom((v) => new Date(v) > new Date()).withMessage('Required-before must be in the future'),
  body('lat').isFloat(), body('lng').isFloat(),
  body('priority').optional().isIn(['NORMAL', 'HIGH', 'CRITICAL']),
]), asyncHandler(async (req, res) => {
  const b = req.body;
  if (req.user.role === 'BENEFICIARY' && +b.quantity > 20) throw new ApiError(400, 'Individual requests are limited to 20 portions. Ask a local NGO for larger needs.');
  const fr = await FoodRequest.create({ requester: req.user._id, requesterRole: req.user.role,
    categories: [].concat(b.categories || []).filter(Boolean), foodRequired: b.foodRequired, quantity: +b.quantity,
    beneficiaries: +b.beneficiaries, requiredBefore: new Date(b.requiredBefore), vegOnly: !!b.vegOnly,
    address: b.address, location: { type: 'Point', coordinates: [+b.lng, +b.lat] },
    priority: req.user.role === 'BENEFICIARY' ? 'NORMAL' : b.priority || 'NORMAL', description: b.description });
  scheduleRematch('new food request');
  res.status(201).json(fr);
}));

r.get('/mine', asyncHandler(async (req, res) => res.json(await FoodRequest.find({ requester: req.user._id }).sort('-createdAt'))));

r.get('/', authorize('ADMIN'), asyncHandler(async (_req, res) => res.json(await FoodRequest.find().populate('requester', 'name role').sort('-createdAt').limit(200))));

r.patch('/:id', asyncHandler(async (req, res) => {
  const fr = await FoodRequest.findOne({ _id: req.params.id, requester: req.user._id });
  if (!fr) throw new ApiError(404, 'Request not found');
  for (const k of ['quantity', 'beneficiaries', 'priority', 'description']) if (req.body[k] !== undefined) fr[k] = req.body[k];
  if (req.body.requiredBefore) fr.requiredBefore = new Date(req.body.requiredBefore);
  if (req.body.status === 'CANCELLED') fr.status = 'CANCELLED';
  await fr.save();
  scheduleRematch(fr.status === 'CANCELLED' ? 'request cancelled' : 'food request changed');
  res.json(fr);
}));

export default r;
