// Test B2 deletion capabilities
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

const config = {
  region: process.env.B2_REGION || 'us-west-004',
  endpoint: process.env.B2_ENDPOINT,
  bucket: process.env.B2_BUCKET,
  keyId: process.env.B2_KEY_ID,
  appKey: process.env.B2_APPLICATION_KEY,
};

console.log('B2 Configuration:');
console.log('- Region:', config.region);
console.log('- Endpoint:', config.endpoint);
console.log('- Bucket:', config.bucket);
console.log('- Key ID:', config.keyId ? `${config.keyId.slice(0, 10)}...` : 'MISSING');
console.log('- App Key:', config.appKey ? 'SET' : 'MISSING');

const s3Client = new S3Client({
  region: config.region,
  endpoint: `https://${config.endpoint}`,
  credentials: {
    accessKeyId: config.keyId,
    secretAccessKey: config.appKey,
  },
});

async function testB2Operations() {
  try {
    // Test 1: List files in asset group
    const assetGroupId = '6df60cb1-8250-4a83-8444-c07357d6622c';
    console.log('\n📋 Test 1: Listing files for asset group:', assetGroupId);

    const listResult = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `assets/${assetGroupId}/`,
      })
    );

    const files = listResult.Contents?.map(obj => obj.Key) || [];
    console.log('✅ Found files:', files);

    if (files.length === 0) {
      console.log('⚠️  No files found - they may have already been deleted');
      return;
    }

    // Test 2: Try to delete one file
    console.log('\n🗑️  Test 2: Attempting to delete first file:', files[0]);

    try {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: files[0],
        })
      );
      console.log('✅ Delete command sent successfully');

      // Verify deletion
      console.log('\n🔍 Test 3: Verifying deletion...');
      const verifyResult = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: `assets/${assetGroupId}/`,
        })
      );

      const remainingFiles = verifyResult.Contents?.map(obj => obj.Key) || [];
      console.log('Remaining files:', remainingFiles);

      if (remainingFiles.length < files.length) {
        console.log('✅ SUCCESS: File was actually deleted from B2!');
      } else {
        console.log('❌ PROBLEM: Delete command succeeded but file still exists in B2!');
        console.log('   This suggests B2 versioning or lifecycle rules are preventing deletion');
      }

    } catch (deleteError) {
      console.error('❌ Delete failed:', deleteError.message);
      console.log('\n💡 Possible causes:');
      console.log('   1. API key lacks deleteFiles permission');
      console.log('   2. Bucket has object lock enabled');
      console.log('   3. Network/connectivity issue');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.log('\nFull error:', error);
  }
}

testB2Operations();
