import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import User from '../models/User.js';
import Delivery from '../models/Delivery.js';
import { Conversation, Message } from '../models/Misc.js';

let io;
const online = new Map(); // userId -> count

export function initSocket(server) {
  io = new Server(server, { cors: { origin: env.clientUrl, credentials: true } });

  io.use(async (socket, next) => {
    try {
      const { sub } = jwt.verify(socket.handshake.auth?.token, env.jwtSecret);
      const user = await User.findById(sub).select('name role accountStatus');
      if (!user || ['SUSPENDED', 'BLOCKED'].includes(user.accountStatus)) return next(new Error('unauthorized'));
      socket.user = user;
      next();
    } catch { next(new Error('unauthorized')); }
  });

  io.on('connection', (socket) => {
    const uid = socket.user._id.toString();
    socket.join(`user:${uid}`);
    socket.join(`role:${socket.user.role}`);
    online.set(uid, (online.get(uid) || 0) + 1);
    io.emit('presence', { userId: uid, online: true });

    socket.on('chat:join', async (conversationId, ack) => {
      const conv = await Conversation.findById(conversationId);
      if (!conv || !conv.participants.some((p) => p.toString() === uid)) return ack?.({ error: 'forbidden' });
      socket.join(`conv:${conversationId}`);
      ack?.({ ok: true });
    });
    socket.on('chat:typing', ({ conversationId, typing }) => {
      socket.to(`conv:${conversationId}`).emit('chat:typing', { conversationId, userId: uid, name: socket.user.name, typing });
    });
    socket.on('chat:send', async ({ conversationId, text }, ack) => {
      if (!text?.trim()) return;
      const conv = await Conversation.findById(conversationId);
      if (!conv || !conv.participants.some((p) => p.toString() === uid)) return ack?.({ error: 'forbidden' });
      const msg = await Message.create({ conversation: conversationId, sender: uid, text: text.trim().slice(0, 2000), readBy: [uid] });
      conv.lastMessageAt = new Date(); await conv.save();
      const payload = { ...msg.toObject(), sender: { _id: uid, name: socket.user.name } };
      io.to(`conv:${conversationId}`).emit('chat:message', payload);
      conv.participants.filter((p) => p.toString() !== uid).forEach((p) => io.to(`user:${p}`).emit('chat:unread', { conversationId }));
      ack?.({ ok: true, message: payload });
    });

    socket.on('tracking:join', async (deliveryId, ack) => {
      const d = await Delivery.findById(deliveryId).populate('donation', 'donor');
      const allowed = d && (socket.user.role === 'ADMIN' || [d.partner, d.recipient, d.donation?.donor].some((x) => x?.toString() === uid));
      if (!allowed) return ack?.({ error: 'forbidden' });
      socket.join(`delivery:${deliveryId}`);
      ack?.({ ok: true });
    });

    socket.on('disconnect', () => {
      const n = (online.get(uid) || 1) - 1;
      if (n <= 0) { online.delete(uid); io.emit('presence', { userId: uid, online: false }); } else online.set(uid, n);
    });
  });
  return io;
}

export const getIO = () => io;
export const isOnline = (id) => online.has(id.toString());
export const emitToUser = (id, event, data) => io?.to(`user:${id}`).emit(event, data);
export const emitToRole = (role, event, data) => io?.to(`role:${role}`).emit(event, data);
export const emitToRoom = (room, event, data) => io?.to(room).emit(event, data);
