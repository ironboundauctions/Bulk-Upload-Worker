import dotenv from 'dotenv';

dotenv.config();

interface Config {
  database: {
    url: string;
  };
  raid: {
    secret: string;
    endpoint: string;
  };
  b2: {
    keyId: string;
    appKey: string;
    bucket: string;
    endpoint: string;
    region: string;
  };
  cdn: {
    baseUrl: string;
  };
  worker: {
    pollInterval: number;
    maxRetries: number;
    logLevel: string;
    concurrency: number;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: Config = {
  database: {
    url: requireEnv('DATABASE_URL'),
  },
  raid: {
    secret: requireEnv('RAID_PUBLISHER_SECRET'),
    endpoint: requireEnv('RAID_PUB_ENDPOINT'),
  },
  b2: {
    keyId: requireEnv('B2_KEY_ID'),
    appKey: requireEnv('B2_APP_KEY'),
    bucket: requireEnv('B2_BUCKET'),
    endpoint: requireEnv('B2_ENDPOINT'),
    region: requireEnv('B2_REGION'),
  },
  cdn: {
    baseUrl: requireEnv('CDN_BASE_URL'),
  },
  worker: {
    pollInterval: Math.max(1000, parseInt(process.env.WORKER_POLL_INTERVAL || '15000', 10) || 15000),
    maxRetries: Math.max(1, parseInt(process.env.MAX_RETRIES || '5', 10) || 5),
    logLevel: process.env.LOG_LEVEL || 'info',
    concurrency: Math.max(1, parseInt(process.env.CONCURRENCY || '3', 10) || 3),
  },
};
