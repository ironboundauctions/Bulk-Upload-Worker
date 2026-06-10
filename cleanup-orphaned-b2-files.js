/**
 * One-time cleanup script to delete orphaned source.webp files from B2
 * These are files that were uploaded during testing but never properly deleted
 */

import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });

const assetGroupIds = [
  'de7f090b-124b-4a44-84d2-6d7bbd0f03e2',
  '2326e6c3-f719-4d62-a168-39ec388cfb48',
  '67725319-24df-46bd-84ed-e53410964bc6',
  'a0e76a7d-4014-40ba-bd75-f1a9ce592fd7',
  '6e5fb8a8-5929-4a86-b949-bfac0e0fcac8',
  '353668cf-baf9-4114-90bf-34761e26100c'
];

async function cleanupOrphanedFiles() {
  const s3Client = new S3Client({
    region: process.env.B2_REGION,
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APP_KEY,
    },
  });

  const keysToDelete = [];

  // Generate all possible file keys for these asset groups
  for (const assetGroupId of assetGroupIds) {
    keysToDelete.push(`assets/${assetGroupId}/source.webp`);
    keysToDelete.push(`assets/${assetGroupId}/thumb.webp`);
    keysToDelete.push(`assets/${assetGroupId}/display.webp`);

    // Video files with different extensions
    const videoExtensions = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
    for (const ext of videoExtensions) {
      keysToDelete.push(`assets/${assetGroupId}/video${ext}`);
    }
  }

  console.log(`Attempting to delete ${keysToDelete.length} potential file keys...`);

  try {
    const result = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: process.env.B2_BUCKET,
        Delete: {
          Objects: keysToDelete.map(Key => ({ Key })),
          Quiet: false,
        },
      })
    );

    console.log('\n✓ Deletion complete!');
    console.log(`  Deleted: ${result.Deleted?.length || 0} files`);
    console.log(`  Errors: ${result.Errors?.length || 0} files`);

    if (result.Deleted && result.Deleted.length > 0) {
      console.log('\nDeleted files:');
      result.Deleted.forEach(file => {
        console.log(`  - ${file.Key}`);
      });
    }

    if (result.Errors && result.Errors.length > 0) {
      console.log('\nErrors:');
      result.Errors.forEach(error => {
        console.log(`  - ${error.Key}: ${error.Message}`);
      });
    }
  } catch (error) {
    console.error('❌ Deletion failed:', error);
    process.exit(1);
  }
}

cleanupOrphanedFiles().catch(console.error);
