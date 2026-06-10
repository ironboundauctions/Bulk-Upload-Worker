import { config } from '../config.js';
import { logger } from '../logger.js';

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
