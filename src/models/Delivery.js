import mongoose from 'mongoose';

const deliverySchema = new mongoose.Schema({
  donation: { type: mongoose.Schema.Types.ObjectId, ref: 'Donation', required: true },
  assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'QuantumMatchingAssignment' },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  partner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  pickup: { address: String, lat: Number, lng: Number },
  dropoff: { address: String, lat: Number, lng: Number },
  status: { type: String, enum: ['AWAITING_PARTNER', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED'], default: 'AWAITING_PARTNER', index: true },
  pickupOtp: { type: String, select: false }, // shown only to donor
  dropoffOtp: { type: String, select: false }, // shown only to recipient
  route: { distanceKm: Number, durationMin: Number, geometry: [[Number]], provider: String },
  track: [{ lat: Number, lng: Number, at: { type: Date, default: Date.now } }],
  timeline: [{ status: String, at: { type: Date, default: Date.now }, note: String }],
  failureReason: String,
}, { timestamps: true });

export default mongoose.model('Delivery', deliverySchema);
