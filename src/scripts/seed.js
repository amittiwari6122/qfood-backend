/** Demo data. Run: npm run seed   (set SEED_LAT / SEED_LNG / SEED_CITY to move it to your city) */
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import User from '../models/User.js';
import NgoProfile from '../models/NgoProfile.js';
import Donation from '../models/Donation.js';
import FoodRequest from '../models/FoodRequest.js';

const LAT = +process.env.SEED_LAT || 19.076, LNG = +process.env.SEED_LNG || 72.8777, CITY = process.env.SEED_CITY || 'Mumbai';
const jitter = (k = 0.04) => (Math.random() - 0.5) * k;
const pt = () => ({ type: 'Point', coordinates: [LNG + jitter(), LAT + jitter()] });
const h = (n) => new Date(Date.now() + n * 36e5);
const PW = 'Password123';

await connectDB();
await Promise.all([User, NgoProfile, Donation, FoodRequest].map((m) => m.deleteMany({})));
const mk = (o) => User.create({ password: PW, phone: `98${Math.floor(1e7 + Math.random() * 9e7)}`, city: CITY, address: `${CITY}`,
  accountStatus: 'ACTIVE', verificationStatus: 'VERIFIED', phoneVerified: true, location: pt(), ...o });

await mk({ name: 'Platform Admin', email: 'admin@foodbridge.dev', role: 'ADMIN' });
const donors = await Promise.all([
  mk({ name: 'Green Leaf Restaurant', email: 'donor1@foodbridge.dev', role: 'DONOR' }),
  mk({ name: 'Sunrise Bakery', email: 'donor2@foodbridge.dev', role: 'DONOR' }),
  mk({ name: 'Hotel Saffron', email: 'donor3@foodbridge.dev', role: 'DONOR' }),
]);
const ngoUsers = await Promise.all([
  mk({ name: 'Annapurna Seva Trust', email: 'ngo1@foodbridge.dev', role: 'NGO' }),
  mk({ name: 'Hope Kitchen Foundation', email: 'ngo2@foodbridge.dev', role: 'NGO' }),
  mk({ name: 'New Shelter Society', email: 'ngo3@foodbridge.dev', role: 'NGO', verificationStatus: 'PENDING' }),
]);
await Promise.all(ngoUsers.map((u, i) => NgoProfile.create({ user: u._id, organizationName: u.name, registrationNumber: `NGO-${2024100 + i}`,
  contactPerson: u.name, phone: u.phone, email: u.email, address: CITY, operatingAreas: [CITY], vegOnly: i === 1,
  verificationStatus: i === 2 ? 'PENDING' : 'VERIFIED' })));
await mk({ name: 'Ravi Kumar', email: 'user@foodbridge.dev', role: 'BENEFICIARY' });
await mk({ name: 'Arjun (Bike)', email: 'rider1@foodbridge.dev', role: 'DELIVERY', available: true, vehicle: 'Bike', deliveryCapacity: 2 });
await mk({ name: 'Meera (Van)', email: 'rider2@foodbridge.dev', role: 'DELIVERY', available: true, vehicle: 'Van', deliveryCapacity: 3 });

const foods = [
  ['Veg biryani', 'cooked', true, 60, 4, 'hot_holding'], ['Dal and rice', 'cooked', true, 40, 3, 'room_temp'],
  ['Chicken curry with rotis', 'cooked', false, 35, 3.5, 'hot_holding'], ['Assorted bread loaves', 'bakery', true, 50, 20, 'room_temp'],
  ['Fresh vegetables crate', 'produce', true, 25, 30, 'refrigerated'], ['Paneer sandwiches', 'cooked', true, 30, 2.5, 'refrigerated'],
];
for (const [i, [foodName, category, isVeg, qty, hrs, storage]] of foods.entries()) {
  await Donation.create({ donor: donors[i % 3]._id, foodName, category, isVeg, quantity: qty, originalQuantity: qty,
    unit: category === 'produce' ? 'kg' : 'meals', peopleServed: qty, preparedAt: h(-1), usableUntil: h(hrs), pickupStart: h(0), pickupEnd: h(Math.min(hrs - 0.5, 6)),
    address: `${CITY} pickup point ${i + 1}`, location: pt(), storageCondition: storage,
    ai: { status: 'MANUAL_REVIEW', provider: 'seed', mode: 'seed', recommendation: 'Seed data, approved by admin' },
    manualReview: { required: true, status: 'APPROVED', notes: 'Seed data' }, status: 'AVAILABLE',
    forSale: i === 3 ? { enabled: true, price: 15 } : undefined });
}
const reqs = [[ngoUsers[0], ['cooked'], 'Dinner for children', 80, 80, 5, 'HIGH', false], [ngoUsers[1], ['cooked', 'bakery'], 'Meals for shelter', 50, 45, 6, 'NORMAL', true],
  [ngoUsers[0], ['produce', 'bakery'], 'Kitchen supplies', 40, 60, 30, 'NORMAL', false], [ngoUsers[2], ['any'], 'Night shelter meals', 30, 30, 4, 'CRITICAL', false]];
for (const [u, categories, foodRequired, quantity, beneficiaries, hrs, priority, vegOnly] of reqs) {
  await FoodRequest.create({ requester: u._id, requesterRole: 'NGO', categories, foodRequired, quantity, beneficiaries, requiredBefore: h(hrs),
    priority, vegOnly, address: CITY, location: pt() });
}
console.log(`Seeded around ${CITY}. All demo passwords: ${PW}
  admin@foodbridge.dev | donor1-3@ | ngo1-3@ (ngo3 pending verification) | user@ | rider1-2@foodbridge.dev`);
await mongoose.disconnect();
