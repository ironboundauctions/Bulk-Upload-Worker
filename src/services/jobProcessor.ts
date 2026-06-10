import { DatabaseService } from './database.js';
import { RaidService } from './raid.js';
import { ImageProcessor } from './imageProcessor.js';
import { StorageService } from './storage.js';
import { logger } from '../logger.js';

export class JobProcessor {
  constructor(
    private db: DatabaseService,
    private raid: RaidService,
    private imageProcessor: ImageProcessor,
    private storage: StorageService
  ) {}

  async processJob(): Promise<boolean> {
    const job = await this.db.getNextJob();

    if (!job) {
      return false;
    }

    logger.info('Processing job', { jobId: job.id, fileId: job.file_id });

    try {
      const file = await this.db.getFileById(job.file_id);

      if (!file) {
        throw new Error(`File not found: ${job.file_id}`);
      }

      logger.debug('File details', {
        fileId: file.id,
        sourceKey: file.source_key,
        originalName: file.original_name,
        variant: file.variant,
        mimeType: file.mime_type,
      });

      if (!file.source_key) {
        throw new Error(`Source file missing source_key: ${file.id}`);
      }

      const sourceBuffer = await this.raid.downloadFile(file.source_key);

      const mimeType = file.mime_type || 'unknown';

      if (this.imageProcessor.isImage(mimeType)) {
        await this.processImage(job, file, sourceBuffer);
      } else if (this.imageProcessor.isVideo(mimeType)) {
        await this.processVideo(job, file, sourceBuffer);
      } else {
        throw new Error(`Unsupported MIME type: ${mimeType}`);
      }

      logger.info('Job completed successfully', {
        jobId: job.id,
        fileId: job.file_id,
      });

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Job processing failed', { jobId: job.id, error: errorMessage });

      await this.db.markJobFailed(job.id, job.file_id, errorMessage);

      return true;
    }
  }

  private async processImage(job: any, file: any, sourceBuffer: Buffer): Promise<void> {
    logger.info('Processing image', { fileId: file.id, assetGroupId: file.asset_group_id });

    const variants = await this.imageProcessor.processImage(sourceBuffer);

    const { thumbUrl, thumbB2Key, displayUrl, displayB2Key } = await this.storage.uploadVariants(
      file.asset_group_id,
      variants.thumb.buffer,
      variants.display.buffer,
      file.item_id || undefined
    );

    await this.db.upsertVariant(file.asset_group_id, 'thumb', thumbUrl, {
      width: variants.thumb.width,
      height: variants.thumb.height,
      b2Key: thumbB2Key,
    });

    await this.db.upsertVariant(file.asset_group_id, 'display', displayUrl, {
      width: variants.display.width,
      height: variants.display.height,
      b2Key: displayB2Key,
    });

    await this.db.markJobCompleted(
      job.id,
      job.file_id,
      '',
      thumbUrl,
      displayUrl
    );

    logger.info('Image processed successfully', {
      fileId: file.id,
      assetGroupId: file.asset_group_id,
      thumbUrl,
      displayUrl,
    });
  }

  private async processVideo(job: any, file: any, sourceBuffer: Buffer): Promise<void> {
    const mimeType = file.mime_type || 'video/mp4';
    logger.info('Processing video', { fileId: file.id, assetGroupId: file.asset_group_id, mimeType });

    const { videoUrl, videoB2Key } = await this.storage.uploadVideo(
      file.asset_group_id,
      sourceBuffer,
      mimeType,
      file.item_id || undefined
    );

    await this.db.upsertVariant(file.asset_group_id, 'video', videoUrl, {
      b2Key: videoB2Key,
    });

    try {
      logger.info('Generating thumbnail from video', { fileId: file.id });
      const variants = await this.imageProcessor.processVideoThumbnail(sourceBuffer);

      const { thumbUrl, thumbB2Key, displayUrl, displayB2Key } = await this.storage.uploadVariants(
        file.asset_group_id,
        variants.thumb.buffer,
        variants.display.buffer,
        file.item_id || undefined
      );

      await this.db.upsertVariant(file.asset_group_id, 'thumb', thumbUrl, {
        width: variants.thumb.width,
        height: variants.thumb.height,
        b2Key: thumbB2Key,
      });

      await this.db.upsertVariant(file.asset_group_id, 'display', displayUrl, {
        width: variants.display.width,
        height: variants.display.height,
        b2Key: displayB2Key,
      });

      await this.db.markJobCompleted(
        job.id,
        job.file_id,
        '',
        thumbUrl,
        displayUrl
      );

      logger.info('Video processed successfully with thumbnail', {
        fileId: file.id,
        assetGroupId: file.asset_group_id,
        videoUrl,
        thumbUrl,
        displayUrl,
      });
    } catch (thumbnailError) {
      logger.error('Video thumbnail generation failed, continuing without thumbnail', {
        fileId: file.id,
        error: thumbnailError instanceof Error ? thumbnailError.message : 'Unknown error',
        stack: thumbnailError instanceof Error ? thumbnailError.stack : undefined,
      });

      await this.db.markJobCompleted(
        job.id,
        job.file_id,
        '',
        '',
        ''
      );

      logger.info('Video processed successfully without thumbnail', {
        fileId: file.id,
        assetGroupId: file.asset_group_id,
        videoUrl,
      });
    }
  }
}
