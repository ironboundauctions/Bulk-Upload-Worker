# Worker Redeployment Instructions

## Changes Made
- Fixed PC uploads to append to the end of the gallery instead of position 0
- Added `getNextDisplayOrder()` function to calculate the correct position
- Updated `upsertVariant()` to accept and set `display_order`

## Files Changed
- `src/services/database.ts` - Added getNextDisplayOrder, updated upsertVariant
- `src/services/uploadHandler.ts` - Now calculates and sets display_order for PC uploads

## How to Deploy

### Option 1: Railway Auto-Deploy (Recommended)
If you have Railway connected to your git repository:

1. Commit and push these changes to your repository
2. Railway will automatically detect and deploy the changes

### Option 2: Manual Railway Deploy
If Railway is not connected to git:

1. Install Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`
3. Link to your project: `railway link`
4. From the worker directory, deploy: `railway up`

### Option 3: Manual Build and Upload
If you don't have Railway CLI access:

1. Build locally (if you have the dependencies):
   ```
   cd worker
   npm install
   npm run build
   ```

2. The built files will be in `dist/`

3. Deploy via Railway web interface or provide the files to someone with access

## Verification After Deploy

After deploying, test by:

1. Opening an existing inventory item
2. Upload a new image via PC upload
3. Verify the new image appears at the END of the gallery, not at position 0 or 1
4. Save the item
5. Reload and verify the order is preserved

## Database Changes
No database migrations needed - the display_order column already exists.
