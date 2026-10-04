/** Image/document storage abstraction: STORAGE_DRIVER=local | cloudinary */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import env from '../../config/env.js';

const UPLOAD_DIR = path.resolve('uploads');

async function compress(file) {
  if (!file.mimetype.startsWith('image/')) return { buffer: file.buffer, ext: path.extname(file.originalname) || '.pdf' };
  const buffer = await sharp(file.buffer).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  return { buffer, ext: '.webp' };
}

const local = {
  async save(file, folder = 'misc') {
    const { buffer, ext } = await compress(file);
    const dir = path.join(UPLOAD_DIR, folder);
    await fs.mkdir(dir, { recursive: true });
    const name = `${crypto.randomUUID()}${ext}`;
    await fs.writeFile(path.join(dir, name), buffer);
    return { url: `/uploads/${folder}/${name}`, publicId: `${folder}/${name}`, buffer };
  },
  async remove(publicId) { await fs.rm(path.join(UPLOAD_DIR, publicId), { force: true }); },
};

const cloudinaryDriver = {
  async client() {
    const { v2 } = await import('cloudinary');
    v2.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
    return v2;
  },
  async save(file, folder = 'misc') {
    const { buffer } = await compress(file);
    const c = await this.client();
    const res = await new Promise((resolve, reject) => {
      c.uploader.upload_stream({ folder: `qfood/${folder}`, resource_type: 'auto' }, (e, r) => (e ? reject(e) : resolve(r))).end(buffer);
    });
    return { url: res.secure_url, publicId: res.public_id, buffer };
  },
  async remove(publicId) { (await this.client()).uploader.destroy(publicId); },
};

export const storage = env.storageDriver === 'cloudinary' ? cloudinaryDriver : local;
export const storageInfo = () => ({ driver: env.storageDriver });
