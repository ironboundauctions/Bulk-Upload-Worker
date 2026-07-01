import { config } from '../config.js';
import { logger } from '../logger.js';

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export class RaidService {
  async downloadFile(fileKey: string): Promise<Buffer> {
    const url = `${config.raid.endpoint}/${fileKey}`;

    logger.debug('Downloading file from RAID', { fileKey, url });

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Auction-Publisher': config.raid.secret,
      },
    });

    if (!response.ok) {
      // 404 = file permanently gone on RAID — no point retrying
      if (response.status === 404) {
        throw new PermanentJobError(
          `RAID file not found (404) — no retry: ${fileKey}`
        );
      }
      throw new Error(
        `RAID download failed: ${response.status} ${response.statusText}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    logger.info('Downloaded file from RAID', {
      fileKey,
      size: buffer.length,
    });

    return buffer;
  }
}
