# Testing Mode Configuration

## Current Settings for B2 Deletion Testing

### Immediate Deletion
- **Before**: Files were deleted 30 days after detachment
- **Now**: Files are deleted immediately after detachment
- **Location**: `worker/src/services/database.ts` - `getFilesForCleanup()`

### Cleanup Frequency
- **Before**: Cleanup ran every 24 hours
- **Now**: Cleanup runs every 2 minutes
- **Initial Run**: After 10 seconds (was 60 seconds)
- **Location**: `worker/src/index.ts` - `scheduleCleanup()`

## How It Works

1. When you delete a file in the webapp, it sets `detached_at` to NOW()
2. Worker checks for files where `detached_at < NOW()` (immediately eligible)
3. Cleanup runs every 2 minutes automatically
4. Files are deleted from B2 and database records are removed

## Testing Workflow

1. Upload a file to test
2. Delete it from the webapp
3. Wait up to 2 minutes for the next cleanup cycle
4. Check your B2 bucket to verify deletion
5. Check worker logs to see deletion activity

## Reverting to Production Settings

When ready for production, change these values back:

**In `worker/src/services/database.ts`:**
```typescript
AND detached_at < NOW() - INTERVAL '30 days'  // Change back from NOW()
```

**In `worker/src/index.ts`:**
```typescript
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;  // 24 hours
setTimeout(..., 60000);  // 60 seconds initial delay
```

## Monitoring

Watch worker logs for these messages:
- "Running scheduled cleanup"
- "Found files to clean"
- "B2 files deleted"
- "Database record deleted"
- "Cleanup process completed"
