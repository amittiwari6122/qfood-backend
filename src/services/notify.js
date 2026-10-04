import { Notification } from '../models/Misc.js';
import { emitToUser } from './socket.js';

export async function notify(userId, { type, title, body, link, data }) {
  const n = await Notification.create({ user: userId, type, title, body, link, data });
  emitToUser(userId, 'notification', n);
  return n;
}
export const notifyMany = (ids, payload) => Promise.all([...new Set(ids.map(String))].map((id) => notify(id, payload)));
