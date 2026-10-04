import multer from 'multer';
import { ApiError } from '../utils/http.js';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => (ALLOWED.includes(file.mimetype) ? cb(null, true) : cb(new ApiError(400, 'Upload JPG, PNG, WEBP or PDF files'))),
});
