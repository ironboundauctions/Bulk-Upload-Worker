import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from '../logger.js';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import crypto from 'crypto';

// Disable libvips cache — prevents unbounded memory growth between jobs
sharp.cache(false);
sharp.concurrency(1);

// Try to find ffmpeg binary path
try {
  const ffmpegPath = execSync('which ffmpeg', { encoding: 'utf-8' }).trim();
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
    logger.info('FFmpeg binary found', { path: ffmpegPath });
  }
} catch (error) {
  logger.warn('Could not locate ffmpeg binary', { error: error instanceof Error ? error.message : 'Unknown' });
}

export interface ImageMetadata {
  width: number;
  height: number;
}

export interface ImageVariant {
  buffer: Buffer;
  width: number;
  height: number;
}

export interface ImageVariants {
  thumb: ImageVariant;
  display: ImageVariant;
}

export class ImageProcessor {
  async processImage(sourceBuffer: Buffer): Promise<ImageVariants> {
    logger.debug('Processing image', { size: sourceBuffer.length });

    try {
      const [thumb, display] = await Promise.all([
        this.createThumbnail(sourceBuffer),
        this.createDisplay(sourceBuffer),
      ]);

      logger.info('Image processed successfully', {
        thumbSize: thumb.buffer.length,
        displaySize: display.buffer.length,
      });

      return { thumb, display };
    } catch (error) {
      logger.error('Image processing failed', error as Error);
      throw error;
    }
  }

  private async createThumbnail(buffer: Buffer): Promise<ImageVariant> {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });

    return { buffer: data, width: info.width, height: info.height };
  }

  private async createDisplay(buffer: Buffer): Promise<ImageVariant> {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer({ resolveWithObject: true });

    return { buffer: data, width: info.width, height: info.height };
  }

  async processVideoThumbnail(videoBuffer: Buffer): Promise<ImageVariants> {
    logger.debug('Generating video thumbnail', { size: videoBuffer.length });

    const tempDir = tmpdir();
    const uniqueId = crypto.randomUUID();
    const videoPath = join(tempDir, `video-${uniqueId}.mp4`);
    const thumbnailPath = join(tempDir, `thumb-${uniqueId}.png`);

    try {
      logger.debug('Writing video to temp file', { videoPath, size: videoBuffer.length });
      await fs.writeFile(videoPath, videoBuffer);

      logger.debug('Starting ffmpeg screenshot extraction', { videoPath, thumbnailPath });
      await new Promise<void>((resolve, reject) => {
        const command = ffmpeg(videoPath)
          .screenshots({
            timestamps: ['00:00:01'],
            filename: thumbnailPath.split('/').pop()!,
            folder: tempDir,
            size: '1600x?'
          });

        command.on('start', (commandLine: string) => {
          logger.debug('FFmpeg command started', { commandLine });
        });

        command.on('end', () => {
          logger.debug('FFmpeg screenshot extraction completed');
          resolve();
        });

        command.on('error', (err: any, stdout: any, stderr: any) => {
          logger.error('FFmpeg error', {
            error: err?.message || String(err),
            stdout: stdout ? String(stdout).substring(0, 500) : '',
            stderr: stderr ? String(stderr).substring(0, 500) : ''
          });
          reject(err);
        });
      });

      const thumbnailBuffer = await fs.readFile(thumbnailPath);

      const [thumb, display] = await Promise.all([
        this.createThumbnail(thumbnailBuffer),
        this.createDisplay(thumbnailBuffer),
      ]);

      await fs.unlink(videoPath).catch(() => {});
      await fs.unlink(thumbnailPath).catch(() => {});

      logger.info('Video thumbnail generated successfully', {
        thumbSize: thumb.buffer.length,
        displaySize: display.buffer.length,
      });

      return { thumb, display };
    } catch (error) {
      await fs.unlink(videoPath).catch(() => {});
      await fs.unlink(thumbnailPath).catch(() => {});
      logger.error('Video thumbnail generation failed', error as Error);
      throw error;
    }
  }

  isImage(mimeType: string): boolean {
    return mimeType.startsWith('image/');
  }

  isVideo(mimeType: string): boolean {
    return mimeType.startsWith('video/');
  }
}
