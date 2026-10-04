/** Lightweight, explainable fraud/risk checks. Flags go to the admin review queue. */
import User from '../models/User.js';
import Donation from '../models/Donation.js';

const DISPOSABLE = ['mailinator.com', 'tempmail.com', '10minutemail.com', 'guerrillamail.com', 'yopmail.com'];

export async function registrationRisk({ email, phone }, ip) {
  const flags = [];
  const domain = email.split('@')[1];
  if (DISPOSABLE.includes(domain)) flags.push('disposable_email');
  if (await User.exists({ phone })) flags.push('phone_reused');
  const recent = await User.countDocuments({ createdAt: { $gt: new Date(Date.now() - 36e5) } });
  if (recent > 50) flags.push('registration_burst');
  return { flags, score: flags.length * 30, ip };
}

export async function donationRisk(donorId, body) {
  const flags = [];
  const lastHour = await Donation.countDocuments({ donor: donorId, createdAt: { $gt: new Date(Date.now() - 36e5) } });
  if (lastHour >= 10) flags.push('high_donation_frequency');
  if (body.quantity > 2000) flags.push('unusually_large_quantity');
  const cancelled = await Donation.countDocuments({ donor: donorId, status: 'CANCELLED' });
  if (cancelled >= 5) flags.push('frequent_cancellations');
  return flags;
}
