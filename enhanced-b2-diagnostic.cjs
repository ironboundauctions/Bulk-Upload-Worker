// Enhanced B2 diagnostic - shows exactly what's being deleted
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const config = {
  region: process.env.B2_REGION || 'us-west-004',
  endpoint: process.env.B2_ENDPOINT,
  bucket: process.env.B2_BUCKET,
  keyId: process.env.B2_KEY_ID,
  appKey: process.env.B2_APPLICATION_KEY,
};

console.log('='.repeat(80));
console.log('B2 DELETE DIAGNOSTIC');
console.log('='.repeat(80));
console.log('\n📋 Configuration:');
console.log('   Region:', config.region);
console.log('   Endpoint:', config.endpoint);
console.log('   Bucket:', config.bucket);
console.log('   Key ID:', config.keyId ? `${config.keyId.slice(0, 15)}...` : '❌ MISSING');
console.log('   App Key:', config.appKey ? '✅ SET' : '❌ MISSING');

if (!config.endpoint || !config.bucket || !config.keyId || !config.appKey) {
  console.error('\n❌ Missing required environment variables!');
  console.log('\nRequired variables:');
  console.log('  - B2_ENDPOINT');
  console.log('  - B2_BUCKET');
  console.log('  - B2_KEY_ID');
  console.log('  - B2_APPLICATION_KEY');
  process.exit(1);
}

const s3Client = new S3Client({
  region: config.region,
  endpoint: `https://${config.endpoint}`,
  credentials: {
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
  },
});

async function diagnosticTest() {
  const assetGroupId = '6df60cb1-8250-4a83-8444-c07357d6622c';
  const prefix = `assets/${assetGroupId}/`;

  try {
    console.log('\n' + '='.repeat(80));
    console.log('TEST 1: LIST FILES');
    console.log('='.repeat(80));
    console.log(`Searching for: ${prefix}`);

    const listResult = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
      })
    );

    const files = listResult.Contents || [];
    console.log(`\n✅ Found ${files.length} files:`);
    files.forEach((file, i) => {
      console.log(`   ${i + 1}. ${file.Key}`);
      console.log(`      Size: ${file.Size} bytes`);
      console.log(`      Last Modified: ${file.LastModified}`);
    });

    if (files.length === 0) {
      console.log('\n⚠️  No files found. Either:');
      console.log('   1. Files have already been deleted');
      console.log('   2. Files are in a different location');
      console.log('   3. Prefix is incorrect');

      console.log('\n🔍 Checking root assets folder...');
      const rootList = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: 'assets/',
          MaxKeys: 20
        })
      );

      if (rootList.Contents && rootList.Contents.length > 0) {
        console.log('\n✅ Found files in assets/ folder:');
        rootList.Contents.slice(0, 10).forEach(file => {
          console.log(`   - ${file.Key}`);
        });
      }
      return;
    }

    console.log('\n' + '='.repeat(80));
    console.log('TEST 2: DELETE FILES (using DeleteObjectsCommand)');
    console.log('='.repeat(80));

    const keysToDelete = files.map(f => f.Key).filter(k => k);
    console.log(`\nAttempting to delete ${keysToDelete.length} files...`);

    const deleteResult = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: {
          Objects: keysToDelete.map(Key => ({ Key })),
          Quiet: false,
        },
      })
    );

    console.log('\n📊 Delete Result:');
    console.log(`   Deleted: ${deleteResult.Deleted?.length || 0} files`);
    console.log(`   Errors: ${deleteResult.Errors?.length || 0} files`);

    if (deleteResult.Deleted && deleteResult.Deleted.length > 0) {
      console.log('\n✅ Successfully deleted:');
      deleteResult.Deleted.forEach(item => {
        console.log(`   - ${item.Key}`);
        console.log(`     Delete Marker: ${item.DeleteMarker}`);
        console.log(`     Version ID: ${item.VersionId || 'none'}`);
      });
    }

    if (deleteResult.Errors && deleteResult.Errors.length > 0) {
      console.log('\n❌ Failed to delete:');
      deleteResult.Errors.forEach(error => {
        console.log(`   - ${error.Key}`);
        console.log(`     Code: ${error.Code}`);
        console.log(`     Message: ${error.Message}`);
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('TEST 3: VERIFY DELETION');
    console.log('='.repeat(80));

    await new Promise(resolve => setTimeout(resolve, 2000));

    const verifyResult = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
      })
    );

    const remainingFiles = verifyResult.Contents || [];
    console.log(`\n🔍 Files remaining: ${remainingFiles.length}`);

    if (remainingFiles.length === 0) {
      console.log('✅ SUCCESS! All files were deleted from B2');
    } else {
      console.log('❌ PROBLEM! Files still exist in B2:');
      remainingFiles.forEach(file => {
        console.log(`   - ${file.Key}`);
      });

      console.log('\n💡 Possible causes:');
      console.log('   1. Bucket has file versioning enabled (check B2 console)');
      console.log('   2. B2 eventual consistency delay (wait a few minutes)');
      console.log('   3. Files were re-created by another process');
      console.log('   4. DeleteMarker was created but file version still exists');

      console.log('\n🔧 Checking for versioning...');
      try {
        const headResult = await s3Client.send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: remainingFiles[0].Key,
          })
        );
        console.log('   Version ID:', headResult.VersionId || 'none');
        console.log('   Delete Marker:', headResult.DeleteMarker || false);
      } catch (e) {
        console.log('   Could not check versioning:', e.message);
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('DIAGNOSTIC COMPLETE');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('\n❌ DIAGNOSTIC FAILED:', error.message);
    console.error('\nFull error:', error);
  }
}

diagnosticTest();
