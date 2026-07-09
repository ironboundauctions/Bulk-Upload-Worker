import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { config } from './config.js';
import { logger } from './logger.js';
import { DatabaseService } from './services/database.js';
import { RaidService } from './services/raid.js';
import { ImageProcessor } from './services/imageProcessor.js';
import { StorageService } from './services/storage.js';
import { JobProcessor } from './services/jobProcessor.js';
import { CleanupProcessor } from './services/cleanupProcessor.js';
import { UploadHandler } from './services/uploadHandler.js';

class MediaPublishingWorker {
  private isShuttingDown = false;
  private db: DatabaseService;
  private storage: StorageService;
  private jobProcessor: JobProcessor;
  private cleanupProcessor: CleanupProcessor;
  private uploadHandler: UploadHandler;
  private activeJobs = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private lastCleanup: Date = new Date(0);
  private httpServer: any;

  constructor() {
    this.db = new DatabaseService();
    const raid = new RaidService();
    const imageProcessor = new ImageProcessor();
    this.storage = new StorageService();

    this.jobProcessor = new JobProcessor(this.db, raid, imageProcessor, this.storage);
    this.cleanupProcessor = new CleanupProcessor(this.db, this.storage);
    this.uploadHandler = new UploadHandler(this.db, imageProcessor, this.storage, raid);
  }

  async start(): Promise<void> {
    logger.info('Starting Media Publishing Worker', {
      pollInterval: config.worker.pollInterval,
      maxRetries: config.worker.maxRetries,
      concurrency: config.worker.concurrency,
    });

    this.setupSignalHandlers();
    this.startHttpServer();
    this.scheduleCleanup();

    while (!this.isShuttingDown) {
      try {
        const promises: Promise<boolean>[] = [];

        for (let i = 0; i < config.worker.concurrency; i++) {
          if (!this.isShuttingDown) {
            promises.push(this.processNextJob());
          }
        }

        const results = await Promise.all(promises);
        const processedCount = results.filter(Boolean).length;

        if (processedCount === 0) {
          await this.sleep(config.worker.pollInterval);
        } else {
          logger.debug(`Processed ${processedCount} jobs`);
        }
      } catch (error) {
        logger.error('Worker loop error', error as Error);
        await this.sleep(5000);
      }
    }

    await this.shutdown();
  }

  private startHttpServer(): void {
    const app = express();
    const upload = multer({ storage: multer.memoryStorage() });

    app.use(express.json());

    app.use((req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Info, Apikey');

      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
      }

      next();
    });

    app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        activeJobs: this.activeJobs
      });
    });

    app.post('/api/upload-and-process', upload.single('file'), async (req: Request, res: Response) => {
      await this.uploadHandler.handlePCUpload(req, res);
    });

    app.post('/api/bulk-upload', upload.array('files', 1000), async (req: Request, res: Response) => {
      await this.uploadHandler.handleBulkUpload(req, res);
    });

    app.post('/api/bulk-process', async (req: Request, res: Response) => {
      await this.uploadHandler.handleBulkProcess(req, res);
    });

    app.post('/api/irondrive-bulk-upload', async (req: Request, res: Response) => {
      await this.uploadHandler.handleIronDriveBulkUpload(req, res);
    });

    app.post('/api/delete-batch-files', async (req: Request, res: Response) => {
      await this.uploadHandler.handleDeleteBatchFiles(req, res);
    });

    app.get('/api/check-asset-group/:assetGroupId', async (req: Request, res: Response) => {
      try {
        const { assetGroupId } = req.params;

        if (!assetGroupId) {
          res.status(400).json({ error: 'Missing assetGroupId' });
          return;
        }

        const dbFiles = await this.db.getFilesByAssetGroup(assetGroupId);
        const itemId = dbFiles.find(f => f.item_id)?.item_id || undefined;
        const files = await this.storage.listAssetGroupFiles(assetGroupId, itemId);

        res.json({
          assetGroupId,
          filesInB2: files,
          filesInDB: dbFiles.map(f => ({ id: f.id, variant: f.variant, detached: !!f.detached_at })),
          b2Count: files.length,
          dbCount: dbFiles.length
        });
      } catch (error) {
        logger.error('Check asset group failed', error as Error);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Check failed'
        });
      }
    });

    app.post('/api/delete-asset-group', async (req: Request, res: Response) => {
      try {
        const { assetGroupId, force } = req.body;

        if (!assetGroupId) {
          res.status(400).json({ error: 'Missing assetGroupId' });
          return;
        }

        logger.info('Immediate deletion request received', { assetGroupId, force: !!force });

        // Skip active-references check when force=true (user explicitly deleting from Recently Removed)
        if (!force) {
          const hasActive = await this.db.hasActiveReferences(assetGroupId);
          if (hasActive) {
            res.status(400).json({
              error: 'Cannot delete: asset group has active references (still attached to items)'
            });
            return;
          }
        }

        // Fetch DB records — they contain the b2_key for each variant
        const filesToDelete = await this.db.getFilesByAssetGroup(assetGroupId);
        const fileIds = filesToDelete.map(f => f.id);

        // Delete from B2 using known b2_keys from DB (avoids slow full-bucket scan).
        // Fall back to path-based listing only if no b2_keys are stored.
        const b2Keys = filesToDelete.map(f => f.b2_key).filter((k): k is string => !!k);

        if (b2Keys.length > 0) {
          await this.storage.deleteFilesByKeys(b2Keys);
          logger.info('Asset group deleted from B2 via keys', { assetGroupId, count: b2Keys.length });
        } else {
          // Fallback: use path-based listing (works when b2_key column was empty)
          const itemId = filesToDelete.find(f => f.item_id)?.item_id || undefined;
          await this.storage.deleteAssetGroup(assetGroupId, itemId);
          logger.info('Asset group deleted from B2 via path scan', { assetGroupId, itemId });
        }

        if (fileIds.length > 0) {
          await this.db.deleteFiles(fileIds);
          logger.info('Database records deleted', { assetGroupId, count: fileIds.length });
        }

        res.json({
          success: true,
          message: `Deleted ${b2Keys.length} B2 file(s) and ${fileIds.length} database record(s)`,
          deletedCount: fileIds.length
        });
      } catch (error) {
        logger.error('Delete asset group failed', error as Error);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Deletion failed'
        });
      }
    });

    app.post('/api/scan-orphaned-b2-files', async (req: Request, res: Response) => {
      try {
        logger.info('B2 orphaned files scan requested - COMPREHENSIVE MODE');
        const startTime = Date.now();

        // Single B2 list + single DB query — no duplicate full-bucket scans
        const [allB2Files, dbFileKeys, dbAssetGroups] = await Promise.all([
          this.storage.listAllFiles(),
          this.db.getAllFileKeys(),
          this.db.getAllAssetGroups(),
        ]);
        logger.info('B2 and DB data fetched', { b2Files: allB2Files.length, dbKeys: dbFileKeys.length });

        const dbKeySet = new Set(dbFileKeys);
        // Asset groups that exist in the DB (may have NULL b2_key for older records)
        const dbAssetGroupSet = new Set(dbAssetGroups);

        // Derive asset group IDs from the already-fetched file list — no second list call
        const b2AssetGroupIds = new Set<string>();
        for (const file of allB2Files) {
          const parts = file.key.split('/');
          if (parts.length >= 4 && parts[0] === 'assets') {
            b2AssetGroupIds.add(parts[2]);
          } else if (parts.length >= 3 && parts[0] === 'assets') {
            b2AssetGroupIds.add(parts[1]);
          }
        }

        // Only flag files older than 24h — mid-upload files may not be in DB yet
        const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const orphanedFiles = allB2Files.filter(file => {
          // Skip if this exact b2_key is in the DB
          if (dbKeySet.has(file.key)) return false;

          // Skip if the file belongs to an asset_group that still exists in the DB.
          // Older records may have b2_key=NULL so they won't appear in dbKeySet,
          // but their asset_group_id is still in the DB — don't treat them as orphans.
          const parts = file.key.split('/');
          if (parts[0] === 'assets') {
            const assetGroupId = parts.length >= 4 ? parts[2] : parts[1];
            if (assetGroupId && dbAssetGroupSet.has(assetGroupId)) return false;
          }

          return new Date(file.lastModified) < staleThreshold;
        });
        const estimatedWastedSpace = orphanedFiles.reduce((sum, file) => sum + file.size, 0);

        logger.info('B2 comprehensive scan complete', {
          totalB2Files: allB2Files.length,
          totalDbFileKeys: dbFileKeys.length,
          totalB2AssetGroups: b2AssetGroupIds.size,
          totalDbAssetGroups: dbAssetGroups.length,
          orphanedFiles: orphanedFiles.length,
          wastedSpace: estimatedWastedSpace
        });

        res.json({
          totalB2Files: allB2Files.length,
          totalB2AssetGroups: b2AssetGroupIds.size,
          totalDbAssetGroups: dbAssetGroups.length,
          orphanedFiles: orphanedFiles.map(f => ({
            key: f.key,
            size: f.size,
            lastModified: f.lastModified
          })),
          estimatedWastedSpace,
          scanDuration: Date.now() - startTime
        });
      } catch (error) {
        logger.error('B2 scan failed', error as Error);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Scan failed'
        });
      }
    });

    app.post('/api/cleanup-orphaned-b2-files', async (req: Request, res: Response) => {
      try {
        const { fileKeys } = req.body;

        if (!Array.isArray(fileKeys) || fileKeys.length === 0) {
          res.status(400).json({ error: 'Missing or invalid fileKeys array' });
          return;
        }

        logger.info('B2 orphaned files cleanup requested - COMPREHENSIVE MODE', { fileCount: fileKeys.length });

        // Group files by asset group ID where possible, otherwise delete individually
        const assetGroupIds = new Set<string>();
        const individualFiles: string[] = [];

        for (const key of fileKeys) {
          const parts = key.split('/');

          // Try to identify asset group pattern
          let foundAssetGroup = false;

          if (parts[0] === 'assets') {
            // New format: assets/{itemId}/{assetGroupId}/file
            if (parts.length >= 4 && parts[2].match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
              assetGroupIds.add(parts[2]);
              foundAssetGroup = true;
            // Old format: assets/{assetGroupId}/file
            } else if (parts.length >= 3 && parts[1].match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
              assetGroupIds.add(parts[1]);
              foundAssetGroup = true;
            }
          }

          // If no asset group pattern found, delete individually
          if (!foundAssetGroup) {
            individualFiles.push(key);
          }
        }

        logger.info('Cleanup strategy determined', {
          assetGroupCount: assetGroupIds.size,
          individualFileCount: individualFiles.length
        });

        let deleted = 0;
        let failed = 0;

        // Delete asset group folders
        for (const assetGroupId of assetGroupIds) {
          try {
            // Fetch DB files to resolve itemId — deleteAssetGroup handles its own B2 listing internally
            const dbFiles = await this.db.getFilesByAssetGroup(assetGroupId);
            const itemId = dbFiles.find(f => f.item_id)?.item_id || undefined;
            logger.info('Deleting asset group folder', { assetGroupId, itemId });

            const b2Deleted = await this.storage.deleteAssetGroup(assetGroupId, itemId);
            deleted += b2Deleted;
            logger.info('Asset group folder deleted', { assetGroupId, b2Deleted });
          } catch (error) {
            logger.error('Failed to delete asset group folder', { assetGroupId, error });
            failed++;
          }
        }

        // Delete individual files (like TEST/TEST.TXT)
        for (const fileKey of individualFiles) {
          try {
            logger.info('Deleting individual file', { fileKey });
            await this.storage.deleteFile(fileKey);
            deleted++;
            logger.info('Individual file deleted', { fileKey });
          } catch (error) {
            logger.error('Failed to delete individual file', { fileKey, error });
            failed++;
          }
        }

        logger.info('B2 cleanup complete', {
          assetGroupsDeleted: assetGroupIds.size,
          individualFilesDeleted: individualFiles.length,
          totalDeleted: deleted,
          totalFailed: failed
        });

        res.json({
          deleted,
          failed,
          assetGroupsDeleted: assetGroupIds.size,
          individualFilesDeleted: individualFiles.length
        });
      } catch (error) {
        logger.error('B2 cleanup failed', error as Error);
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Cleanup failed'
        });
      }
    });

    const port = process.env.PORT || 3000;
    this.httpServer = app.listen(port, () => {
      logger.info(`HTTP server listening on port ${port}`);
    });
  }

  private scheduleCleanup(): void {
    const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // Every 6 hours

    this.cleanupTimer = setInterval(async () => {
      if (!this.isShuttingDown) {
        try {
          logger.info('Running scheduled cleanup');
          await this.cleanupProcessor.processCleanup();

          logger.info('Running expired batch cleanup');
          await this.cleanupProcessor.cleanupExpiredBatches();

          this.lastCleanup = new Date();
        } catch (error) {
          logger.error('Cleanup failed', error as Error);
        }
      }
    }, CLEANUP_INTERVAL);

    // Run initial cleanup after 5 minutes to allow system to settle
    setTimeout(async () => {
      try {
        logger.info('Running initial cleanup');
        await this.cleanupProcessor.processCleanup();
        await this.cleanupProcessor.cleanupExpiredBatches();
        this.lastCleanup = new Date();
      } catch (error) {
        logger.error('Initial cleanup failed', error as Error);
      }
    }, 5 * 60 * 1000);
  }

  private async processNextJob(): Promise<boolean> {
    if (this.isShuttingDown) {
      return false;
    }

    this.activeJobs++;
    try {
      return await this.jobProcessor.processJob();
    } finally {
      this.activeJobs--;
    }
  }

  private setupSignalHandlers(): void {
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM signal');
      this.isShuttingDown = true;
    });

    process.on('SIGINT', () => {
      logger.info('Received SIGINT signal');
      this.isShuttingDown = true;
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled rejection', reason as Error);
    });
  }

  private async shutdown(): Promise<void> {
    logger.info('Shutting down gracefully...');

    if (this.httpServer) {
      this.httpServer.close();
      logger.info('HTTP server closed');
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const shutdownDeadline = Date.now() + 30_000;
    while (this.activeJobs > 0) {
      if (Date.now() > shutdownDeadline) {
        logger.warn(`Shutdown timeout reached with ${this.activeJobs} active jobs still running — forcing exit`);
        break;
      }
      logger.info(`Waiting for ${this.activeJobs} active jobs to complete`);
      await this.sleep(1000);
    }

    await this.db.close();
    logger.info('Worker shutdown complete');
    process.exit(0);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const worker = new MediaPublishingWorker();
worker.start().catch((error) => {
  logger.error('Worker failed to start', error);
  process.exit(1);
});
