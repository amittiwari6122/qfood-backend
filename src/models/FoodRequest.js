import mongoose from 'mongoose';

const requestSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  requesterRole: { type: String, enum: ['NGO', 'BENEFICIARY'], required: true },
  categories: [{ type: String }],
  foodRequired: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  fulfilledQuantity: { type: Number, default: 0 },
  beneficiaries: { type: Number, required: true, min: 1 },
  requiredBefore: { type: Date, required: true },
  vegOnly: { type: Boolean, default: false },
  address: String,
  location: { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], required: true } },
  priority: { type: String, enum: ['NORMAL', 'HIGH', 'CRITICAL'], default: 'NORMAL' },
  description: String,
  status: { type: String, enum: ['OPEN', 'PARTIALLY_FULFILLED', 'FULFILLED', 'EXPIRED', 'CANCELLED'], default: 'OPEN', index: true },
}, { timestamps: true });
requestSchema.index({ location: '2dsphere' });

export default mongoose.model('FoodRequest', requestSchema);
