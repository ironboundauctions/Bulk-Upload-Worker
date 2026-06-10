import { DatabaseService, AuctionFile } from './database.js';
import { StorageService } from './storage.js';
import { logger } from '../logger.js';

export class CleanupProcessor {
  constructor(
    private db: DatabaseService,
    private storage: StorageService
  ) {}

  async processCleanup(): Promise<number> {
    logger.info('Starting cleanup process');

    const filesToClean = await this.db.getFilesForCleanup();

    if (filesToClean.length === 0) {
      logger.info('No files to clean up');
      return 0;
    }

    // Deduplicate by asset group — multiple detached rows per group should be handled in one pass
    const seenGroups = new Set<string>();
    const uniqueFiles = filesToClean.filter(f => {
      if (seenGroups.has(f.asset_group_id)) return false;
      seenGroups.add(f.asset_group_id);
      return true;
    });

    logger.info('Found files to clean', { rows: filesToClean.length, uniqueGroups: uniqueFiles.length });

    let successCount = 0;

    for (const file of uniqueFiles) {
      try {
        await this.cleanupFile(file);
        successCount++;
      } catch (error) {
        logger.error('Failed to cleanup file', {
          fileId: file.id,
          assetGroupId: file.asset_group_id,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    logger.info('Cleanup process completed', {
      total: uniqueFiles.length,
      success: successCount,
      failed: uniqueFiles.length - successCount
    });

    return successCount;
  }

  async cleanupExpiredBatches(): Promise<number> {
    logger.info('Starting expired batch cleanup');

    const expiredBatches = await this.db.getExpiredBatchJobs();

    if (expiredBatches.length === 0) {
      logger.info('No expired batches to clean up');
      return 0;
    }

    logger.info('Found expired batches', { count: expiredBatches.length });

    let successCount = 0;

    for (const batch of expiredBatches) {
      try {
        // Delete all files from this batch
        const assetGroupIds = this.extractAssetGroupIds(batch.uploaded_files);

        let batchCleanOk = true;

        for (const assetGroupId of assetGroupIds) {
          // Fetch DB files first to get itemId for targeted B2 path, and to have IDs ready for deletion
          const files = await this.db.getFilesByAssetGroup(assetGroupId);
          const itemId = files.find(f => f.item_id)?.item_id || undefined;

          let b2Ok = false;
          try {
            await this.storage.deleteAssetGroup(assetGroupId, itemId);
            b2Ok = true;
            logger.info('Deleted expired batch files from B2', { assetGroupId, itemId, batchId: batch.id });
          } catch (error) {
            batchCleanOk = false;
            logger.error('Failed to delete batch files from B2', {
              assetGroupId,
              batchId: batch.id,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }

          // Only delete DB records if B2 deletion succeeded — keeps them for retry
          if (b2Ok) {
            const fileIds = files.map(f => f.id);
            if (fileIds.length > 0) {
              try {
                await this.db.deleteFiles(fileIds);
                logger.info('Deleted expired batch file records', {
                  assetGroupId,
                  batchId: batch.id,
                  count: fileIds.length,
                });
              } catch (error) {
                batchCleanOk = false;
                logger.error('Failed to delete batch file records', {
                  assetGroupId,
                  batchId: batch.id,
                  error: error instanceof Error ? error.message : 'Unknown error',
                });
              }
            }
          }
        }

        // Only mark expired when all asset groups cleaned up successfully
        if (batchCleanOk) {
          await this.db.markBatchExpired(batch.id);
          successCount++;
          logger.info('Marked batch as expired', { batchId: batch.id });
        } else {
          logger.warn('Skipping markBatchExpired — some asset groups failed to clean up', { batchId: batch.id });
        }
      } catch (error) {
        logger.error('Failed to cleanup expired batch', {
          batchId: batch.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    logger.info('Expired batch cleanup completed', {
      total: expiredBatches.length,
      success: successCount,
      failed: expiredBatches.length - successCount,
    });

    return successCount;
  }

  private extractAssetGroupIds(uploadedFiles: any): string[] {
    try {
      const files = typeof uploadedFiles === 'string' ? JSON.parse(uploadedFiles) : uploadedFiles;
      if (Array.isArray(files)) {
        return files.map((f: any) => f.assetGroupId).filter(Boolean);
      }
      return [];
    } catch (error) {
      logger.error('Failed to extract asset group IDs', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }

  private async cleanupFile(file: AuctionFile): Promise<void> {
    logger.info('Cleaning up file', {
      fileId: file.id,
      assetGroupId: file.asset_group_id
    });

    const hasActive = await this.db.hasActiveReferences(file.asset_group_id);

    if (hasActive) {
      logger.info('Skipping cleanup - asset group has active references', {
        fileId: file.id,
        assetGroupId: file.asset_group_id
      });
      return;
    }

    if (file.item_id) {
      const safeToDelete = await this.db.isItemSafeToDelete(file.item_id);
      if (!safeToDelete) {
        logger.warn('Skipping cleanup - linked inventory item is still active (not deleted)', {
          fileId: file.id,
          itemId: file.item_id,
          assetGroupId: file.asset_group_id
        });
        return;
      }
    }

    // Fetch all sibling records BEFORE any destructive operation so IDs are stable
    const allGroupFiles = await this.db.getFilesByAssetGroup(file.asset_group_id);
    const allFileIds = allGroupFiles.length > 0 ? allGroupFiles.map(f => f.id) : [file.id];

    // Resolve item_id from siblings — ensures targeted B2 path
    const resolvedItemId = (file.item_id || allGroupFiles.find(s => s.item_id)?.item_id) ?? undefined;

    let b2DeletionSuccess = false;
    let dbDeletionSuccess = false;
    let errorMessage: string | null = null;

    try {
      await this.storage.deleteAssetGroup(file.asset_group_id, resolvedItemId);
      b2DeletionSuccess = true;
      logger.info('B2 files deleted', { assetGroupId: file.asset_group_id, itemId: resolvedItemId });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Unknown B2 deletion error';
      logger.error('B2 deletion failed', {
        assetGroupId: file.asset_group_id,
        error: errorMessage
      });
    }

    if (b2DeletionSuccess) {
      try {
        await this.db.deleteFiles(allFileIds);
        dbDeletionSuccess = true;
        logger.info('Database records deleted', { assetGroupId: file.asset_group_id, count: allFileIds.length, ids: allFileIds });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'Unknown DB deletion error';
        logger.error('Database deletion failed', {
          fileId: file.id,
          assetGroupId: file.asset_group_id,
          error: errorMessage
        });
      }
    } else {
      logger.warn('Skipping database deletion due to B2 deletion failure', {
        fileId: file.id
      });
    }

    if (!b2DeletionSuccess || !dbDeletionSuccess) {
      throw new Error(errorMessage || 'Cleanup failed');
    }
  }
}
