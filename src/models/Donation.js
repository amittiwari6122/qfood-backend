import mongoose from 'mongoose';

export const DONATION_STATUS = ['AVAILABLE', 'PENDING_REVIEW', 'MATCHED', 'ACCEPTED', 'PICKED_UP',
  'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'REJECTED'];

const donationSchema = new mongoose.Schema({
  donor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  foodName: { type: String, required: true },
  category: { type: String, required: true, enum: ['cooked', 'bakery', 'produce', 'dairy', 'packaged', 'beverages', 'other'] },
  foodType: String,
  isVeg: { type: Boolean, required: true },
  quantity: { type: Number, required: true, min: 1 },
  originalQuantity: Number,
  unit: { type: String, default: 'meals' },
  peopleServed: { type: Number, min: 1 },
  preparedAt: { type: Date, required: true },
  usableUntil: { type: Date, required: true, index: true },
  pickupStart: { type: Date, required: true },
  pickupEnd: { type: Date, required: true },
  address: { type: String, required: true },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true },
  },
  storageCondition: { type: String, enum: ['room_temp', 'refrigerated', 'frozen', 'hot_holding'], default: 'room_temp' },
  packaging: String,
  description: String,
  images: [{ url: String, publicId: String }],
  ai: {
    status: { type: String, enum: ['SAFE', 'CAUTION', 'UNSAFE', 'MANUAL_REVIEW', 'NOT_ANALYZED'], default: 'NOT_ANALYZED' },
    qualityScore: Number,
    confidence: Number,
    indicators: [String],
    recommendation: String,
    provider: String,
    mode: String,
    analyzedAt: Date,
    raw: mongoose.Schema.Types.Mixed,
  },
  manualReview: { required: { type: Boolean, default: false }, status: { type: String, enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'], default: 'NONE' }, notes: String },
  status: { type: String, enum: DONATION_STATUS, default: 'AVAILABLE', index: true },
  forSale: { enabled: { type: Boolean, default: false }, price: Number, currency: { type: String, default: 'INR' } },
  matchedRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRequest' },
  matchedNgo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  matchRunId: String,
  rejectedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { timestamps: true });

donationSchema.index({ location: '2dsphere' });
donationSchema.virtual('remainingMinutes').get(function remaining() {
  return Math.max(0, Math.round((this.usableUntil - Date.now()) / 60000));
});
donationSchema.set('toJSON', { virtuals: true });

export default mongoose.model('Donation', donationSchema);
