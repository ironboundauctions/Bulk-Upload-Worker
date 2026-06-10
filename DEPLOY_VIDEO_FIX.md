# Deploy Video Thumbnail Fix to Railway

This update adds video thumbnail generation to the worker so videos display properly with thumbnails.

## Changes Made

1. **Added ffmpeg support** - Videos now generate thumbnails at 1 second
2. **Updated dependencies** - Added `fluent-ffmpeg` and types
3. **Updated imageProcessor** - Added `processVideoThumbnail()` method
4. **Updated jobProcessor** - Videos now generate both thumbnails and upload the video file
5. **Added nixpacks.toml** - Ensures ffmpeg is installed on Railway

## Deployment Steps

### Option 1: Via Railway CLI (Recommended)

```bash
cd worker
railway up
```

### Option 2: Via Railway Dashboard

1. Go to your Railway project: https://railway.app/
2. Click on your worker service
3. Go to "Settings" → "Deploy"
4. Click "Deploy Now" or wait for automatic deployment from git

### Option 3: Manual Upload

1. Extract `worker-deployment-video-fix.tar.gz` to your local directory
2. Push to your git repository
3. Railway will automatically detect and deploy the changes

## What This Fixes

- Videos now generate thumbnail images (thumb and display variants)
- Video thumbnails are extracted at the 1-second mark of the video
- Videos display with a proper preview image instead of a blank square
- If thumbnail generation fails, the video still uploads without thumbnails (graceful fallback)

## Environment Variables

No new environment variables are required. The worker uses the existing:
- B2_APPLICATION_KEY_ID
- B2_APPLICATION_KEY
- B2_BUCKET_NAME
- B2_CDN_URL
- DATABASE_URL

## Testing

After deployment:
1. Upload a new video file
2. Check that the publish job completes
3. Verify that thumb, display, and video variants are all created
4. Confirm the video shows a thumbnail preview in the UI

## Railway Build

Railway will automatically:
1. Install ffmpeg via nixpacks.toml
2. Run `npm install` to get fluent-ffmpeg
3. Build TypeScript with `npm run build`
4. Start the worker with `npm start`
