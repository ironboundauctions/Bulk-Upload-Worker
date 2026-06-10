import { Request, Response } from 'express';
import { ImageProcessor } from './imageProcessor.js';
import { StorageService } from './storage.js';
import { DatabaseService } from './database.js';
import { RaidService } from './raid.js';
import { logger } from '../logger.js';
import crypto from 'crypto';

export class UploadHandler {
  constructor(
    private db: DatabaseService,
    private imageProcessor: ImageProcessor,
    private storage: StorageService,
    private raid: RaidService
  ) {}

  async handlePCUpload(req: Request, res: Response): Promise<void> {
    let assetGroupId: string | undefined;
    let createdFileIds: string[] = [];

    try {
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      const { item_id } = req.body;

      if (!item_id) {
        res.status(400).json({ error: 'item_id is required' });
        return;
      }

      logger.info('Processing PC upload', {
        filename: req.file.originalname,
        size: req.file.size,
        item_id
      });

      // Get the next display_order for this item (max + 1, or 0 if no files yet)
      const nextDisplayOrder = await this.db.getNextDisplayOrder(item_id);

      assetGroupId = crypto.randomUUID();
      const isVideo = this.imageProcessor.isVideo(req.file.mimetype);
      const uploadResults = [];

      if (isVideo) {
        // --- Video upload path ---
        // 1. Store the original video file as the 'video' variant
        const ext = req.file.originalname.split('.').pop()?.toLowerCase() || 'mp4';
        const videoB2Key = `assets/${item_id}/${assetGroupId}/video.${ext}`;
        const videoCdnUrl = this.storage.getCdnUrl(videoB2Key);
        await this.storage.uploadFile(videoB2Key, req.file.buffer, req.file.mimetype);

        const videoVariantId = await this.db.upsertVariant(
          assetGroupId,
          'video',
          videoCdnUrl,
          { b2Key: videoB2Key, width: 0, height: 0, displayOrder: nextDisplayOrder, itemId: item_id }
        );
        createdFileIds.push(videoVariantId);
        await this.db.setVariantItemAndMetadata(videoVariantId, item_id, req.file.originalname, req.file.buffer.length, req.file.mimetype);

        uploadResults.push({
          variant: 'video',
          b2_key: videoB2Key,
          cdn_url: videoCdnUrl,
          id: videoVariantId,
          width: 0,
          height: 0
        });

        // 2. Generate thumbnail from first frame (best-effort — skip if ffmpeg unavailable)
        try {
          const thumbnailVariants = await this.imageProcessor.processVideoThumbnail(req.file.buffer);

          for (const { name, data } of [
            { name: 'thumb', data: thumbnailVariants.thumb },
            { name: 'display', data: thumbnailVariants.display }
          ]) {
            const b2Key = `assets/${item_id}/${assetGroupId}/${name}.webp`;
            const cdnUrl = this.storage.getCdnUrl(b2Key);
            await this.storage.uploadFile(b2Key, data.buffer, 'image/webp');

            const variantId = await this.db.upsertVariant(
              assetGroupId,
              name,
              cdnUrl,
              { b2Key, width: data.width, height: data.height, displayOrder: nextDisplayOrder, itemId: item_id }
            );
            createdFileIds.push(variantId);
            await this.db.setVariantItemAndMetadata(variantId, item_id, req.file.originalname, data.buffer.length, 'image/webp');

            uploadResults.push({ variant: name, b2_key: b2Key, cdn_url: cdnUrl, id: variantId, width: data.width, height: data.height });
          }
        } catch (thumbError) {
          logger.warn('Video thumbnail generation failed — video still uploaded', {
            error: thumbError instanceof Error ? thumbError.message : String(thumbError)
          });
        }
      } else {
        // --- Image upload path (original logic) ---
        const variants = await this.imageProcessor.processImage(req.file.buffer);

        // Upload source variant (original file, converted to WebP)
        const sourceB2Key = `assets/${item_id}/${assetGroupId}/source.webp`;
        const sourceCdnUrl = this.storage.getCdnUrl(sourceB2Key);
        await this.storage.uploadFile(sourceB2Key, variants.display.buffer, 'image/webp');

        const sourceVariantId = await this.db.upsertVariant(
          assetGroupId,
          'source',
          sourceCdnUrl,
          {
            b2Key: sourceB2Key,
            width: variants.display.width,
            height: variants.display.height,
            displayOrder: nextDisplayOrder,
            itemId: item_id
          }
        );
        createdFileIds.push(sourceVariantId);
        await this.db.setVariantItemAndMetadata(sourceVariantId, item_id, req.file.originalname, variants.display.buffer.length, 'image/webp');

        uploadResults.push({
          variant: 'source',
          b2_key: sourceB2Key,
          cdn_url: sourceCdnUrl,
          id: sourceVariantId,
          width: variants.display.width,
          height: variants.display.height
        });

        // Upload display and thumb variants
        for (const { name, data } of [
          { name: 'thumb', data: variants.thumb },
          { name: 'display', data: variants.display }
        ]) {
          const b2Key = `assets/${item_id}/${assetGroupId}/${name}.webp`;
          const cdnUrl = this.storage.getCdnUrl(b2Key);
          await this.storage.uploadFile(b2Key, data.buffer, 'image/webp');

          const variantId = await this.db.upsertVariant(
            assetGroupId,
            name,
            cdnUrl,
            { b2Key, width: data.width, height: data.height, displayOrder: nextDisplayOrder, itemId: item_id }
          );
          createdFileIds.push(variantId);
          await this.db.setVariantItemAndMetadata(variantId, item_id, req.file.originalname, data.buffer.length, 'image/webp');

          uploadResults.push({ variant: name, b2_key: b2Key, cdn_url: cdnUrl, id: variantId, width: data.width, height: data.height });
        }
      }

      logger.info('PC upload completed successfully', {
        item_id,
        asset_group_id: assetGroupId,
        isVideo,
        variants: uploadResults.length
      });

      res.json({
        success: true,
        asset_group_id: assetGroupId,
        files: uploadResults
      });

    } catch (error) {
      logger.error('PC upload failed, cleaning up', {
        error: error as Error,
        assetGroupId,
        createdFileIds: createdFileIds.length
      });

      // Cleanup: Delete any files that were created in B2 and DB
      if (assetGroupId) {
        try {
          await this.storage.deleteAssetGroup(assetGroupId, req.body.item_id);
          logger.info('Cleaned up B2 files for failed upload', { assetGroupId });
        } catch (cleanupError) {
          logger.error('Failed to cleanup B2 files', { assetGroupId, error: cleanupError });
        }
      }

      if (createdFileIds.length > 0) {
        try {
          await this.db.deleteFiles(createdFileIds);
          logger.info('Cleaned up DB records for failed upload', { count: createdFileIds.length });
        } catch (cleanupError) {
          logger.error('Failed to cleanup DB records', { error: cleanupError });
        }
      }

      res.status(500).json({
        error: 'Upload failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async handleBulkUpload(req: Request, res: Response): Promise<void> {
    try {
      if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        res.status(400).json({ error: 'No files provided' });
        return;
      }

      logger.info('Processing bulk inventory upload', { count: req.files.length });

      // Process files in batches of 5 for parallel processing
      const BATCH_SIZE = 5;
      const allResults: any[] = [];
      const allErrors: any[] = [];

      for (let i = 0; i < req.files.length; i += BATCH_SIZE) {
        const batch = req.files.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
          batch.map(async (file) => {
            const assetGroupId = crypto.randomUUID();

            try {
              // Process image to get all variants
              const variants = await this.imageProcessor.processImage(file.buffer);

              // Upload all variants to B2 using hybrid structure (no item_id)
              const uploadedVariants = [];

              // Upload source variant
              const sourceB2Key = `assets/${assetGroupId}/source.webp`;
              const sourceCdnUrl = this.storage.getCdnUrl(sourceB2Key);
              await this.storage.uploadFile(sourceB2Key, variants.display.buffer, 'image/webp');
              uploadedVariants.push({
                variant: 'source',
                cdnUrl: sourceCdnUrl,
                width: variants.display.width,
                height: variants.display.height,
              });

              // Upload display and thumb variants
              for (const [variantName, variantData] of Object.entries(variants)) {
                if (variantName === 'display' || variantName === 'thumb') {
                  const b2Key = `assets/${assetGroupId}/${variantName}.webp`;
                  const cdnUrl = this.storage.getCdnUrl(b2Key);
                  await this.storage.uploadFile(b2Key, variantData.buffer, 'image/webp');
                  uploadedVariants.push({
                    variant: variantName,
                    cdnUrl,
                    width: variantData.width,
                    height: variantData.height,
                  });
                }
              }

              return {
                fileName: file.originalname,
                fileSize: file.size,
                mimeType: file.mimetype,
                assetGroupId,
                cdnUrls: {
                  source: uploadedVariants.find(v => v.variant === 'source')?.cdnUrl,
                  display: uploadedVariants.find(v => v.variant === 'display')?.cdnUrl,
                  thumb: uploadedVariants.find(v => v.variant === 'thumb')?.cdnUrl,
                },
                width: variants.display.width,
                height: variants.display.height,
              };
            } catch (error) {
              // If upload fails, cleanup the B2 files that were created
              logger.error('Failed to process file in bulk upload, cleaning up', {
                fileName: file.originalname,
                assetGroupId,
                error
              });

              try {
                await this.storage.deleteAssetGroup(assetGroupId);
                logger.info('Cleaned up B2 files for failed bulk upload', { assetGroupId });
              } catch (cleanupError) {
                logger.error('Failed to cleanup B2 files for failed bulk upload', { assetGroupId, error: cleanupError });
              }

              throw error;
            }
          })
        );

        const successful = results
          .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
          .map(r => r.value);

        const failed = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map(r => ({ error: r.reason instanceof Error ? r.reason.message : String(r.reason) }));

        allResults.push(...successful);
        allErrors.push(...failed);
      }

      logger.info('Bulk inventory upload completed', {
        total: req.files.length,
        successful: allResults.length,
        failed: allErrors.length,
      });

      res.json({
        success: true,
        uploadedFiles: allResults,
        errors: allErrors.length > 0 ? allErrors : undefined,
      });

    } catch (error) {
      logger.error('Bulk inventory upload failed', error as Error);
      res.status(500).json({
        error: 'Bulk upload failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async handleBulkProcess(req: Request, res: Response): Promise<void> {
    try {
      const { groups } = req.body;

      if (!groups || !Array.isArray(groups) || groups.length === 0) {
        res.status(400).json({ error: 'groups array is required' });
        return;
      }

      logger.info('Processing bulk inventory creation', {
        groupCount: groups.length,
      });

      const results = [];
      const errors = [];

      for (const group of groups) {
        try {
          const { inv_number, files } = group;

          if (!inv_number || !files || files.length === 0) {
            errors.push({
              inv_number,
              error: 'Invalid group structure',
            });
            continue;
          }

          // Link files to database by creating auction_files records
          let displayOrder = 0;
          for (const file of files) {
            const { assetGroupId, fileName, cdnUrls } = file;

            // Create database records for each variant
            for (const [variant, cdnUrl] of Object.entries(cdnUrls)) {
              if (cdnUrl) {
                const b2Key = `assets/${assetGroupId}/${variant}.webp`;

                const variantId = await this.db.upsertVariant(
                  assetGroupId,
                  variant,
                  cdnUrl as string,
                  {
                    b2Key,
                    width: file.width || 0,
                    height: file.height || 0,
                    displayOrder,
                  }
                );

                // Note: item_id will be null initially, will be set when inventory items are created
                await this.db.setVariantMetadata(
                  variantId,
                  fileName,
                  file.fileSize || 0,
                  file.mimeType || 'image/webp'
                );
              }
            }

            displayOrder++;
          }

          results.push({
            inv_number,
            fileCount: files.length,
            assetGroupIds: files.map((f: any) => f.assetGroupId),
          });
        } catch (error) {
          logger.error('Error processing group', {
            inv_number: group.inv_number,
            error: error instanceof Error ? error.message : String(error),
          });
          errors.push({
            inv_number: group.inv_number,
            error: error instanceof Error ? error.message : 'Processing failed',
          });
        }
      }

      logger.info('Bulk process completed', {
        total: groups.length,
        successful: results.length,
        failed: errors.length,
      });

      res.json({
        success: true,
        processed: results,
        errors: errors.length > 0 ? errors : undefined,
      });

    } catch (error) {
      logger.error('Bulk process failed', error as Error);
      res.status(500).json({
        error: 'Bulk process failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async handleIronDriveBulkUpload(req: Request, res: Response): Promise<void> {
    try {
      const { sourceKeys } = req.body;

      if (!sourceKeys || !Array.isArray(sourceKeys) || sourceKeys.length === 0) {
        res.status(400).json({ error: 'sourceKeys array is required' });
        return;
      }

      logger.info('Processing IronDrive bulk upload', { count: sourceKeys.length });

      const BATCH_SIZE = 10;
      const allResults: any[] = [];
      const allErrors: any[] = [];

      for (let i = 0; i < sourceKeys.length; i += BATCH_SIZE) {
        const batch = sourceKeys.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
          batch.map(async (sourceKey: string) => {
            const assetGroupId = crypto.randomUUID();
            const fileName = sourceKey.split('/').pop() || sourceKey;

            try {
              const buffer = await this.raid.downloadFile(sourceKey);
              const variants = await this.imageProcessor.processImage(buffer);

              const sourceB2Key = `assets/${assetGroupId}/source.webp`;
              const displayB2Key = `assets/${assetGroupId}/display.webp`;
              const thumbB2Key = `assets/${assetGroupId}/thumb.webp`;

              const sourceCdnUrl = this.storage.getCdnUrl(sourceB2Key);
              const displayCdnUrl = this.storage.getCdnUrl(displayB2Key);
              const thumbCdnUrl = this.storage.getCdnUrl(thumbB2Key);

              await Promise.all([
                this.storage.uploadFile(sourceB2Key, variants.display.buffer, 'image/webp'),
                this.storage.uploadFile(displayB2Key, variants.display.buffer, 'image/webp'),
                this.storage.uploadFile(thumbB2Key, variants.thumb.buffer, 'image/webp'),
              ]);

              return {
                fileName,
                sourceKey,
                fileSize: buffer.length,
                mimeType: 'image/webp',
                assetGroupId,
                cdnUrls: {
                  source: sourceCdnUrl,
                  display: displayCdnUrl,
                  thumb: thumbCdnUrl,
                },
                width: variants.display.width,
                height: variants.display.height,
              };
            } catch (error) {
              logger.error('Failed to process IronDrive file', { sourceKey, assetGroupId, error });
              try {
                await this.storage.deleteAssetGroup(assetGroupId);
              } catch (cleanupError) {
                logger.error('Failed to cleanup B2 files for failed IronDrive upload', { assetGroupId, error: cleanupError });
              }
              throw error;
            }
          })
        );

        results
          .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
          .forEach(r => allResults.push(r.value));

        results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .forEach(r => allErrors.push({ error: r.reason instanceof Error ? r.reason.message : String(r.reason) }));
      }

      logger.info('IronDrive bulk upload completed', {
        total: sourceKeys.length,
        successful: allResults.length,
        failed: allErrors.length,
      });

      res.json({
        success: true,
        uploadedFiles: allResults,
        errors: allErrors.length > 0 ? allErrors : undefined,
      });

    } catch (error) {
      logger.error('IronDrive bulk upload failed', error as Error);
      res.status(500).json({
        error: 'IronDrive bulk upload failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async handleDeleteBatchFiles(req: Request, res: Response): Promise<void> {
    try {
      const { assetGroupIds } = req.body;

      if (!assetGroupIds || !Array.isArray(assetGroupIds) || assetGroupIds.length === 0) {
        res.status(400).json({ error: 'assetGroupIds array is required' });
        return;
      }

      logger.info('Deleting batch files', { count: assetGroupIds.length });

      const results = [];
      const errors = [];

      for (const assetGroupId of assetGroupIds) {
        try {
          // Fetch DB records first to resolve itemId for targeted B2 path
          const filesToDelete = await this.db.getFilesByAssetGroup(assetGroupId);
          const itemId = filesToDelete.find(f => f.item_id)?.item_id || undefined;
          const fileIds = filesToDelete.map(f => f.id);

          await this.storage.deleteAssetGroup(assetGroupId, itemId);

          if (fileIds.length > 0) {
            await this.db.deleteFiles(fileIds);
          }

          results.push({
            assetGroupId,
            deletedCount: fileIds.length,
          });
        } catch (error) {
          logger.error('Error deleting asset group', {
            assetGroupId,
            error: error instanceof Error ? error.message : String(error),
          });
          errors.push({
            assetGroupId,
            error: error instanceof Error ? error.message : 'Deletion failed',
          });
        }
      }

      logger.info('Batch file deletion completed', {
        total: assetGroupIds.length,
        successful: results.length,
        failed: errors.length,
      });

      res.json({
        success: true,
        deleted: results,
        errors: errors.length > 0 ? errors : undefined,
      });

    } catch (error) {
      logger.error('Delete batch files failed', error as Error);
      res.status(500).json({
        error: 'Delete batch files failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
