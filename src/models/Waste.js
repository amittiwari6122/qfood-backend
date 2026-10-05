import mongoose from 'mongoose';
const { ObjectId } = mongoose.Schema.Types;

/** Food nobody could be matched with before it expired: goes to a waste-management partner (compost / biogas / animal feed). */
const wasteSchema = new mongoose.Schema({
  donation: { type: ObjectId, ref: 'Donation', required: true, unique: true },
  donor: { type: ObjectId, ref: 'User', required: true, index: true },
  foodName: String, quantity: Number, unit: String, isVeg: Boolean,
  method: { type: String, enum: ['COMPOST', 'BIOGAS', 'ANIMAL_FEED'], default: 'COMPOST' },
  address: String,
  lat: Number, lng: Number,
  reason: { type: String, default: 'No NGO match before the food expired' },
  status: { type: String, enum: ['PENDING', 'ACCEPTED', 'COLLECTED', 'CANCELLED'], default: 'PENDING', index: true },
  collector: { type: ObjectId, ref: 'User' },
  acceptedAt: Date, collectedAt: Date,
}, { timestamps: true });

export default mongoose.model('Waste', wasteSchema);
