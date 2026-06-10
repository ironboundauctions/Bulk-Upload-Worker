#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

const WORKER_URL = 'https://ibaproject-production.up.railway.app';

async function testActualUpload() {
  console.log('Testing actual file upload to worker...\n');

  // Create a simple test image (1x1 pixel PNG)
  const testImageBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  const formData = new FormData();
  formData.append('file', testImageBuffer, {
    filename: 'test.png',
    contentType: 'image/png',
  });
  formData.append('item_id', '00000000-0000-0000-0000-000000000000'); // Test UUID

  try {
    console.log('Uploading test image...');
    const response = await fetch(`${WORKER_URL}/api/upload-and-process`, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders(),
    });

    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers.entries()));

    const responseText = await response.text();
    console.log('Response body:', responseText);

    try {
      const jsonData = JSON.parse(responseText);
      console.log('\nParsed JSON:', JSON.stringify(jsonData, null, 2));
    } catch (e) {
      console.log('\nResponse is not valid JSON');
    }

  } catch (error) {
    console.error('Upload failed:', error.message);
    if (error.cause) {
      console.error('Cause:', error.cause);
    }
  }
}

testActualUpload().catch(console.error);
