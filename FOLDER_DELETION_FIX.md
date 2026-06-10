# Folder Deletion Fix - March 5, 2026

## Problem

The worker was attempting to delete files individually by guessing filenames:
- `assets/{id}/thumb.webp`
- `assets/{id}/display.webp`
- `assets/{id}/source.webp`
- `assets/{id}/video.mp4` (and .mov, .webm, .avi, .mkv)

This approach had critical flaws:
1. If a file had an unexpected name, it would be left behind
2. Required maintaining a list of all possible file extensions
3. Left empty folders in B2
4. Created orphaned files when variants changed

## Solution

Changed `deleteAssetGroup()` to delete the entire folder instead:

**Before:**
```typescript
async deleteAssetGroup(assetGroupId: string, variants: string[] = ['source', 'thumb', 'display', 'video']): Promise<void> {
  // Build list of expected filenames
  // Try to delete each one
}
```

**After:**
```typescript
async deleteAssetGroup(assetGroupId: string): Promise<void> {
  // List ALL files in assets/{assetGroupId}/
  // Delete everything found
}
```

## Benefits

1. **Complete cleanup** - Deletes everything in the folder, no exceptions
2. **No assumptions** - Doesn't need to know filenames or extensions
3. **No orphans** - Folders are completely removed
4. **Future-proof** - Works with any file type or naming convention
5. **Simpler code** - No variant parameter needed

## Changes Made

### `/worker/src/services/storage.ts`

```typescript
async deleteAssetGroup(assetGroupId: string): Promise<void> {
  logger.info('Deleting entire asset group folder from B2', { assetGroupId });

  try {
    // List all files in the folder
    const files = await this.listAssetGroupFiles(assetGroupId);

    if (files.length === 0) {
      logger.info('No files found for asset group', { assetGroupId });
      return;
    }

    // Delete everything found
    const result = await this.s3Client.send(
      new DeleteObjectsCommand({
        Bucket: config.b2.bucket,
        Delete: {
          Objects: files.map(Key => ({ Key })),
          Quiet: false,
        },
      })
    );

    logger.info('Asset group folder deletion complete', {
      assetGroupId,
      filesFound: files.length,
      deleted: result.Deleted?.length || 0,
      errors: result.Errors?.length || 0
    });
  } catch (error) {
    logger.error('Asset group deletion failed', { assetGroupId, error: error as Error });
    throw error;
  }
}
```

## Deployment

1. Build the updated worker:
   ```bash
   cd worker
   npm run build
   ```

2. Create deployment package:
   ```bash
   tar -czf worker-folder-deletion-fix.tar.gz --exclude='node_modules' --exclude='.env' .
   ```

3. Deploy to Railway (same process as before)

## Cleanup of Existing Orphans

After deploying the fix, clean up the 6 existing orphaned files:

```bash
./cleanup-6-orphaned-files.sh
```

Or manually via API:
```bash
curl -X POST https://ibaproject-production.up.railway.app/api/delete-asset-group \
  -H "Content-Type: application/json" \
  -d '{"assetGroupId": "de7f090b-124b-4a44-84d2-6d7bbd0f03e2"}'
```

## Verification

Check if files are gone:
```bash
curl https://ibaproject-production.up.railway.app/api/check-asset-group/de7f090b-124b-4a44-84d2-6d7bbd0f03e2
```

Expected result:
```json
{
  "assetGroupId": "de7f090b-124b-4a44-84d2-6d7bbd0f03e2",
  "filesInB2": [],
  "filesInDB": [],
  "b2Count": 0,
  "dbCount": 0
}
```
