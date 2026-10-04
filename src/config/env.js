import dotenv from 'dotenv';
dotenv.config();

const env = {
  port: +process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/qfood',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  quantumUrl: process.env.QUANTUM_SERVICE_URL || 'http://localhost:8001',
  quantumMode: process.env.QUANTUM_MODE || 'simulator',
  quantumAutoMatch: process.env.QUANTUM_AUTO_MATCH !== 'false',
  quantumDebounceMs: +process.env.QUANTUM_DEBOUNCE_MS || 8000,
  aiProvider: process.env.AI_PROVIDER || 'dev',
  storageDriver: process.env.STORAGE_DRIVER || 'local',
};
if (env.nodeEnv === 'production' && env.jwtSecret === 'dev-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}
export default env;
