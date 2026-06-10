import { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { logger } from '../logger.js';

export class StorageService {
  private s3Client: S3Client;

  constructor() {
    this.s3Client = new S3Client({
      region: config.b2.region,
      endpoint: `https://${config.b2.endpoint}`,
      credentials: {
        accessKeyId: config.b2.keyId,
        secretAccessKey: config.b2.appKey,
      },
    });
  }

  async uploadFile(key: string, data: Buffer, contentType: string): Promise<string> {
    logger.debug('Uploading file to B2', { key, size: data.length, contentType });

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: config.b2.bucket,
          Key: key,
          Body: data,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        })
      );

      const url = `${config.cdn.baseUrl}/${key}`;
      logger.info('File uploaded successfully', { key, url });

      return url;
    } catch (error) {
      logger.error('File upload failed', error as Error);
      throw error;
    }
  }

  async uploadVariants(
    assetGroupId: string,
    thumbBuffer: Buffer,
    displayBuffer: Buffer,
    itemId?: string
  ): Promise<{ thumbUrl: string; thumbB2Key: string; displayUrl: string; displayB2Key: string }> {
    if (!itemId) {
      throw new Error('item_id is required for B2 upload path generation');
    }
    const thumbKey = `assets/${itemId}/${assetGroupId}/thumb.webp`;
    const displayKey = `assets/${itemId}/${assetGroupId}/display.webp`;

    const [thumbUrl, displayUrl] = await Promise.all([
      this.uploadFile(thumbKey, thumbBuffer, 'image/webp'),
      this.uploadFile(displayKey, displayBuffer, 'image/webp'),
    ]);

    return {
      thumbUrl,
      thumbB2Key: thumbKey,
      displayUrl,
      displayB2Key: displayKey,
    };
  }

  async uploadVideo(
    assetGroupId: string,
    videoBuffer: Buffer,
    mimeType: string,
    itemId?: string
  ): Promise<{ videoUrl: string; videoB2Key: string }> {
    if (!itemId) {
      throw new Error('item_id is required for B2 upload path generation');
    }
    const extension = this.getVideoExtension(mimeType);
    const videoKey = `assets/${itemId}/${assetGroupId}/video${extension}`;

    const videoUrl = await this.uploadFile(videoKey, videoBuffer, mimeType);

    return {
      videoUrl,
      videoB2Key: videoKey,
    };
  }

  private getVideoExtension(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'video/webm': '.webm',
      'video/x-msvideo': '.avi',
      'video/x-matroska': '.mkv',
    };

    return mimeToExt[mimeType] || '.mp4';
  }

  async deleteFilesByKeys(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;

    logger.info('Deleting files from B2 by key list', { count: keys.length });

    const result = await this.s3Client.send(
      new DeleteObjectsCommand({
        Bucket: config.b2.bucket,
        Delete: {
          Objects: keys.map(Key => ({ Key })),
          Quiet: false,
        },
      })
    );

    const deletedCount = result.Deleted?.length || 0;
    const errorCount = result.Errors?.length || 0;

    if (errorCount > 0) {
      logger.error('Some files failed to delete from B2', { errors: result.Errors });
      throw new Error(`Partial B2 deletion: ${errorCount} of ${keys.length} files failed`);
    }

    logger.info('Files deleted from B2', { deletedCount });
    return deletedCount;
  }

  async deleteFile(key: string): Promise<void> {
    logger.debug('Deleting file from B2', { key });

    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: config.b2.bucket,
          Key: key,
        })
      );

      logger.info('File deleted successfully', { key });
    } catch (error) {
      logger.error('File deletion failed', { key, error: error as Error });
      throw error;
    }
  }

  async deleteAssetGroup(assetGroupId: string, itemId?: string): Promise<number> {
    logger.info('Deleting entire asset group folder from B2', { assetGroupId, itemId });

    try {
      const files = await this.listAssetGroupFiles(assetGroupId, itemId);

      if (files.length === 0) {
        logger.info('No files found for asset group', { assetGroupId });
        return 0;
      }

      const result = await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: config.b2.bucket,
          Delete: {
            Objects: files.map(Key => ({ Key })),
            Quiet: false,
          },
        })
      );

      const deletedCount = result.Deleted?.length || 0;
      const errorCount = result.Errors?.length || 0;

      if (errorCount > 0) {
        logger.error('Some files failed to delete from B2', {
          assetGroupId,
          errors: result.Errors,
          deleted: deletedCount,
          failed: errorCount
        });
        throw new Error(`Partial B2 deletion: ${errorCount} of ${files.length} files failed for asset group ${assetGroupId}`);
      }

      logger.info('Asset group folder deletion complete', {
        assetGroupId,
        filesFound: files.length,
        deleted: deletedCount
      });
      return deletedCount;
    } catch (error) {
      logger.error('Asset group deletion failed', { assetGroupId, error: error as Error });
      throw error;
    }
  }

  generateCdnKeyPrefix(assetGroupId: string, itemId?: string): string {
    if (!itemId) {
      throw new Error('item_id is required for B2 path generation');
    }
    return `assets/${itemId}/${assetGroupId}`;
  }

  getCdnUrl(key: string): string {
    return `${config.cdn.baseUrl}/${key}`;
  }

  async listAssetGroupFiles(assetGroupId: string, itemId?: string): Promise<string[]> {
    try {
      // If itemId is provided, use specific path
      if (itemId) {
        const prefix = `assets/${itemId}/${assetGroupId}/`;
        const result = await this.s3Client.send(
          new ListObjectsV2Command({
            Bucket: config.b2.bucket,
            Prefix: prefix,
          })
        );
        return result.Contents?.map(obj => obj.Key).filter((k): k is string => !!k) || [];
      }

      // itemId missing — must scan entire bucket to find files by asset group ID.
      // This is expensive and should rarely happen. Callers should always resolve itemId from DB first.
      logger.warn('listAssetGroupFiles called without itemId — full bucket scan required', { assetGroupId });
      const allFiles: string[] = [];

      let continuationToken: string | undefined;
      do {
        const result = await this.s3Client.send(
          new ListObjectsV2Command({
            Bucket: config.b2.bucket,
            Prefix: 'assets/',
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          })
        );

        if (result.Contents) {
          for (const obj of result.Contents) {
            if (!obj.Key) continue;

            // Check if this file belongs to the asset group
            const parts = obj.Key.split('/');

            // New format: assets/{itemId}/{assetGroupId}/file
            if (parts.length >= 4 && parts[2] === assetGroupId) {
              allFiles.push(obj.Key);
            }
            // Old format: assets/{assetGroupId}/file
            else if (parts.length >= 3 && parts[1] === assetGroupId) {
              allFiles.push(obj.Key);
            }
          }
        }

        continuationToken = result.NextContinuationToken;
      } while (continuationToken);

      logger.debug('Found files for asset group', { assetGroupId, fileCount: allFiles.length });
      return allFiles;
    } catch (error) {
      logger.error('Failed to list asset group files', { assetGroupId, error: error as Error });
      throw error;
    }
  }

  async listAllAssetGroups(): Promise<{ assetGroupId: string; key: string; size: number; lastModified: string }[]> {
    logger.info('Listing all asset groups from B2');
    const allFiles: { assetGroupId: string; key: string; size: number; lastModified: string }[] = [];

    try {
      let continuationToken: string | undefined;

      do {
        const result = await this.s3Client.send(
          new ListObjectsV2Command({
            Bucket: config.b2.bucket,
            Prefix: 'assets/',
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          })
        );

        if (result.Contents) {
          for (const obj of result.Contents) {
            if (!obj.Key) continue;

            // Extract asset group ID from path: assets/{itemId}/{assetGroupId}/file
            // OR from old format: assets/{assetGroupId}/file
            const parts = obj.Key.split('/');

            let assetGroupId: string | null = null;

            if (parts.length >= 3) {
              // Could be new format: assets/{itemId}/{assetGroupId}/file
              // or old format: assets/{assetGroupId}/file
              const potentialAssetGroupId = parts[2];

              // Check if it looks like a UUID (basic check)
              if (potentialAssetGroupId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
                assetGroupId = potentialAssetGroupId;
              } else {
                // Might be old format, check if parts[1] is UUID
                const oldFormatId = parts[1];
                if (oldFormatId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
                  assetGroupId = oldFormatId;
                }
              }
            }

            if (assetGroupId) {
              allFiles.push({
                assetGroupId,
                key: obj.Key,
                size: obj.Size || 0,
                lastModified: obj.LastModified?.toISOString() || new Date().toISOString(),
              });
            }
          }
        }

        continuationToken = result.NextContinuationToken;
      } while (continuationToken);

      logger.info('B2 files listed', { totalFiles: allFiles.length });
      return allFiles;
    } catch (error) {
      logger.error('Failed to list all asset groups', error as Error);
      throw error;
    }
  }

  async listAllFiles(): Promise<{ key: string; size: number; lastModified: string }[]> {
    logger.info('Listing ALL files from entire B2 bucket');
    const allFiles: { key: string; size: number; lastModified: string }[] = [];

    try {
      let continuationToken: string | undefined;

      do {
        const result = await this.s3Client.send(
          new ListObjectsV2Command({
            Bucket: config.b2.bucket,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          })
        );

        if (result.Contents) {
          for (const obj of result.Contents) {
            if (!obj.Key) continue;

            allFiles.push({
              key: obj.Key,
              size: obj.Size || 0,
              lastModified: obj.LastModified?.toISOString() || new Date().toISOString(),
            });
          }
        }

        continuationToken = result.NextContinuationToken;
      } while (continuationToken);

      logger.info('All B2 files listed', { totalFiles: allFiles.length });
      return allFiles;
    } catch (error) {
      logger.error('Failed to list all files', error as Error);
      throw error;
    }
  }
}
