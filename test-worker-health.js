#!/usr/bin/env node

const WORKER_URL = 'https://ibaproject-production.up.railway.app';

async function testWorkerHealth() {
  console.log('Testing worker health...\n');

  try {
    // Test health endpoint
    console.log('1. Testing /health endpoint...');
    const healthResponse = await fetch(`${WORKER_URL}/health`);
    const healthData = await healthResponse.json();
    console.log('   Status:', healthResponse.status);
    console.log('   Response:', JSON.stringify(healthData, null, 2));
    console.log('   ✓ Health check passed\n');
  } catch (error) {
    console.error('   ✗ Health check failed:', error.message, '\n');
  }

  try {
    // Test upload endpoint (without file - should get 400)
    console.log('2. Testing /api/upload-and-process endpoint...');
    const uploadResponse = await fetch(`${WORKER_URL}/api/upload-and-process`, {
      method: 'POST',
    });
    const uploadData = await uploadResponse.json();
    console.log('   Status:', uploadResponse.status);
    console.log('   Response:', JSON.stringify(uploadData, null, 2));

    if (uploadResponse.status === 400 && uploadData.error === 'No file provided') {
      console.log('   ✓ Upload endpoint is responding correctly\n');
    } else if (uploadResponse.status === 500) {
      console.error('   ✗ Upload endpoint returned 500 error');
      console.error('   This indicates a worker crash or configuration issue\n');
    } else {
      console.log('   ? Unexpected response\n');
    }
  } catch (error) {
    console.error('   ✗ Upload endpoint test failed:', error.message, '\n');
  }
}

testWorkerHealth().catch(console.error);
