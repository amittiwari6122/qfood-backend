import { Router } from 'express';
import Waste from '../models/Waste.js';
import { protect, authorize } from '../middleware/auth.js';
import { notify } from '../services/notify.js';
import { ApiError, asyncHandler } from '../utils/http.js';

const r = Router();
r.use(protect);
const POP = [{ path: 'donor', select: 'name phone' }, { path: 'collector', select: 'name phone vehicle' }];

r.get('/', asyncHandler(async (req, res) => {
  const u = req.user;
  let f = {};
  if (u.role === 'DONOR') f = { donor: u._id };
  else if (u.role === 'WASTE_PARTNER') f = { $or: [{ status: 'PENDING' }, { collector: u._id }] };
  else if (u.role !== 'ADMIN') return res.json([]);
  res.json(await Waste.find(f).populate(POP).sort('-createdAt').limit(100));
}));

r.post('/:id/accept', authorize('WASTE_PARTNER'), asyncHandler(async (req, res) => {
  const w = await Waste.findOneAndUpdate({ _id: req.params.id, status: 'PENDING' },
    { status: 'ACCEPTED', collector: req.user._id, acceptedAt: new Date() }, { new: true }).populate(POP);
  if (!w) throw new ApiError(409, 'Another waste partner already took this pickup');
  await notify(w.donor._id, { type: 'waste', title: 'Waste partner is coming', body: `${req.user.name} will collect ${w.foodName} for ${w.method.replace('_', ' ').toLowerCase()}.`, link: '/app/waste' });
  res.json(w);
}));

r.post('/:id/collected', authorize('WASTE_PARTNER'), asyncHandler(async (req, res) => {
  const w = await Waste.findOneAndUpdate({ _id: req.params.id, collector: req.user._id, status: 'ACCEPTED' },
    { status: 'COLLECTED', collectedAt: new Date() }, { new: true }).populate(POP);
  if (!w) throw new ApiError(404, 'Pickup not found');
  await notify(w.donor._id, { type: 'waste', title: 'Waste collected', body: `${w.foodName} was collected and sent for ${w.method.replace('_', ' ').toLowerCase()}. Thank you for not letting it go to landfill.`, link: '/app/waste' });
  res.json(w);
}));

export default r;
