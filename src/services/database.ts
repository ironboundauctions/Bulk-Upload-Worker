import pg from 'pg';
import crypto from 'crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

const { Pool } = pg;

export interface PublishJob {
  id: string;
  file_id: string;
  asset_group_id: string | null;
  source_item_id: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  priority: number;
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  run_after: Date;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AuctionFile {
  id: string;
  item_id: string | null;
  asset_group_id: string;
  variant: 'source' | 'thumb' | 'display' | 'video';
  source_key: string | null;
  b2_key: string | null;
  cdn_url: string | null;
  original_name: string;
  bytes: number | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  published_status: 'pending' | 'processing' | 'published' | 'failed';
  detached_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class DatabaseService {
  private pool: pg.Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: config.database.url,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    this.pool.on('error', (err) => {
      logger.error('Unexpected database error', err);
    });
  }

  async getNextJob(): Promise<PublishJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query<PublishJob>(
        `UPDATE publish_jobs
         SET status = 'processing',
             started_at = NOW(),
             updated_at = NOW()
         WHERE id = (
           SELECT id
           FROM publish_jobs
           WHERE status IN ('pending', 'failed')
             AND retry_count < max_retries
             AND run_after <= NOW()
           ORDER BY priority DESC, run_after ASC, created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`
      );

      await client.query('COMMIT');

      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getFileById(fileId: string): Promise<AuctionFile | null> {
    const result = await this.pool.query<AuctionFile>(
      'SELECT * FROM auction_files WHERE id = $1',
      [fileId]
    );
    return result.rows[0] || null;
  }

  async markJobCompleted(
    jobId: string,
    fileId: string,
    cdnKeyPrefix: string,
    thumbUrl: string,
    displayUrl: string
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE publish_jobs
         SET status = 'completed',
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [jobId]
      );

      await client.query(
        `UPDATE auction_files
         SET published_status = 'published',
             updated_at = NOW()
         WHERE id = $1 AND variant = 'source'`,
        [fileId]
      );

      await client.query('COMMIT');
      logger.info('Job completed successfully', { jobId, fileId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getNextDisplayOrder(itemId: string): Promise<number> {
    const result = await this.pool.query<{ max_order: number | null }>(
      `SELECT COALESCE(MAX(display_order), -1) + 1 as max_order
       FROM auction_files
       WHERE item_id = $1`,
      [itemId]
    );
    return parseInt(String(result.rows[0]?.max_order ?? 0), 10);
  }

  async upsertVariant(
    assetGroupId: string,
    variant: string,
    cdnUrl: string,
    metadata: {
      width?: number;
      height?: number;
      durationSeconds?: number;
      b2Key?: string;
      displayOrder?: number;
      itemId?: string;
    }
  ): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO auction_files (
        asset_group_id,
        variant,
        item_id,
        cdn_url,
        b2_key,
        width,
        height,
        duration_seconds,
        original_name,
        published_status,
        display_order
      )
      SELECT
        $1::uuid,
        $2::text,
        COALESCE($9::uuid, src.item_id),
        $3::text,
        $4::text,
        $5::integer,
        $6::integer,
        $7::numeric,
        '',
        'published',
        $8::integer
      FROM (SELECT 1) AS dummy
      LEFT JOIN auction_files src ON src.asset_group_id = $1 AND src.variant = 'source'
      LIMIT 1
      ON CONFLICT (asset_group_id, variant)
      DO UPDATE SET
        item_id = COALESCE(EXCLUDED.item_id, auction_files.item_id),
        cdn_url = EXCLUDED.cdn_url,
        b2_key = EXCLUDED.b2_key,
        width = EXCLUDED.width,
        height = EXCLUDED.height,
        duration_seconds = EXCLUDED.duration_seconds,
        published_status = 'published',
        display_order = COALESCE(EXCLUDED.display_order, auction_files.display_order),
        updated_at = NOW()
      RETURNING id`,
      [
        assetGroupId,
        variant,
        cdnUrl,
        metadata.b2Key || null,
        metadata.width || null,
        metadata.height || null,
        metadata.durationSeconds || null,
        metadata.displayOrder ?? 0,
        metadata.itemId || null,
      ]
    );

    if (!result.rows[0]) {
      throw new Error(`upsertVariant returned no row for assetGroupId=${assetGroupId} variant=${variant}`);
    }
    return result.rows[0].id;
  }

  async setVariantItemAndMetadata(
    variantId: string,
    itemId: string,
    originalName: string,
    bytes: number,
    mimeType: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE auction_files
       SET item_id = $1,
           original_name = $2,
           bytes = $3,
           mime_type = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [itemId, originalName, bytes, mimeType, variantId]
    );
  }

  async setVariantMetadata(
    variantId: string,
    originalName: string,
    bytes: number,
    mimeType: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE auction_files
       SET original_name = $1,
           bytes = $2,
           mime_type = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [originalName, bytes, mimeType, variantId]
    );
  }

  async markJobFailed(jobId: string, fileId: string, errorMessage: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query<{ retry_count: number; max_retries: number }>(
        `SELECT retry_count, max_retries FROM publish_jobs WHERE id = $1`,
        [jobId]
      );

      const job = result.rows[0];
      if (!job) {
        throw new Error(`Job not found for markJobFailed: ${jobId}`);
      }
      const newRetryCount = job.retry_count + 1;
      const willRetry = newRetryCount < job.max_retries;

      const backoffSeconds = willRetry ? Math.pow(2, newRetryCount) * 60 : 0;

      await client.query(
        `UPDATE publish_jobs
         SET status = $1,
             retry_count = retry_count + 1,
             error_message = $2,
             run_after = NOW() + ($4 * INTERVAL '1 second'),
             completed_at = CASE WHEN $1 = 'failed' THEN NOW() ELSE completed_at END,
             updated_at = NOW()
         WHERE id = $3`,
        [willRetry ? 'pending' : 'failed', errorMessage, jobId, backoffSeconds]
      );

      await client.query(
        `UPDATE auction_files
         SET published_status = $1
         WHERE id = $2 AND variant = 'source'`,
        [willRetry ? 'pending' : 'failed', fileId]
      );

      await client.query('COMMIT');
      logger.warn('Job failed', {
        jobId,
        fileId,
        retryCount: newRetryCount,
        willRetry,
        backoffSeconds
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getFilesForCleanup(): Promise<AuctionFile[]> {
    const result = await this.pool.query<AuctionFile>(
      `SELECT * FROM auction_files
       WHERE detached_at IS NOT NULL
         AND detached_at < NOW() - INTERVAL '1 hour'
       ORDER BY detached_at ASC
       LIMIT 100`
    );
    return result.rows;
  }

  async hasActiveReferences(assetGroupId: string): Promise<boolean> {
    // Only block deletion when files are actively attached to an item (item_id is set and not detached).
    // Abandoned uploads (item_id IS NULL) are never "active references" — they have no item to protect.
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM auction_files
       WHERE asset_group_id = $1
         AND item_id IS NOT NULL
         AND (detached_at IS NULL OR detached_at > NOW() - INTERVAL '1 hour')`,
      [assetGroupId]
    );

    const count = parseInt(result.rows[0]?.count || '0', 10);
    return count > 0;
  }

  async isItemSafeToDelete(itemId: string): Promise<boolean> {
    const result = await this.pool.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM inventory_items WHERE id = $1`,
      [itemId]
    );

    if (result.rows.length === 0) return true;
    return result.rows[0].deleted_at !== null;
  }

  async getFilesByAssetGroup(assetGroupId: string): Promise<AuctionFile[]> {
    const result = await this.pool.query<AuctionFile>(
      `SELECT * FROM auction_files WHERE asset_group_id = $1`,
      [assetGroupId]
    );
    return result.rows;
  }

  async deleteFiles(fileIds: string[]): Promise<void> {
    if (fileIds.length === 0) return;

    await this.pool.query(
      `DELETE FROM auction_files WHERE id = ANY($1)`,
      [fileIds]
    );

    logger.info('Deleted files from database', { count: fileIds.length });
  }

  async getExpiredBatchJobs(): Promise<any[]> {
    // Include 'processing' batches that are past expires_at — these are jobs where the
    // client persisted uploaded_files and set status='processing' but then crashed before
    // confirmBatch finished. Files in uploaded_files are in B2 with no DB records yet.
    const result = await this.pool.query(
      `SELECT id, uploaded_files
       FROM batch_analysis_jobs
       WHERE status IN ('ready_for_review', 'processing')
         AND expires_at < NOW()
       LIMIT 50`
    );
    return result.rows;
  }

  async markBatchExpired(batchId: string): Promise<void> {
    await this.pool.query(
      `UPDATE batch_analysis_jobs
       SET status = 'expired',
           updated_at = NOW()
       WHERE id = $1`,
      [batchId]
    );
  }

  async createAuctionFile(data: {
    lot_id: string | null;
    inventory_item_id: string | null;
    variant: string;
    b2_key: string;
    source_key: string | null;
    status: string;
    uploaded_from: string;
    file_size: number;
    width?: number;
    height?: number;
    format: string;
  }): Promise<{ id: string }> {
    const assetGroupId = crypto.randomUUID();
    const cdnUrl = `${config.cdn.baseUrl}/${data.b2_key}`;

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO auction_files (
        item_id,
        asset_group_id,
        variant,
        b2_key,
        cdn_url,
        source_key,
        original_name,
        bytes,
        mime_type,
        width,
        height,
        published_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id`,
      [
        data.inventory_item_id || data.lot_id,
        assetGroupId,
        data.variant,
        data.b2_key,
        cdnUrl,
        data.source_key,
        `${data.variant}_${Date.now()}.${data.format}`,
        data.file_size,
        `image/${data.format}`,
        data.width || null,
        data.height || null,
        'published'
      ]
    );

    return result.rows[0];
  }

  async getAllAssetGroups(): Promise<string[]> {
    const result = await this.pool.query<{ asset_group_id: string }>(
      `SELECT DISTINCT asset_group_id
       FROM auction_files
       WHERE asset_group_id IS NOT NULL
       ORDER BY asset_group_id`
    );

    return result.rows.map(row => row.asset_group_id);
  }

  async getAllFileKeys(): Promise<string[]> {
    const result = await this.pool.query<{ b2_key: string }>(
      `SELECT DISTINCT b2_key
       FROM auction_files
       WHERE b2_key IS NOT NULL
       ORDER BY b2_key`
    );

    return result.rows.map(row => row.b2_key);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
