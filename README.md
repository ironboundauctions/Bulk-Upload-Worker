# Media Publishing Worker

Background worker service that processes auction media files by downloading from RAID, creating optimized WebP variants, and uploading to Backblaze B2 with CDN distribution.

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌──────────────┐      ┌─────────┐
│ Edge Func   │─────▶│ publish_jobs │─────▶│    Worker    │─────▶│   B2    │
│ (attach)    │      │   (queue)    │      │  (processor) │      │ Storage │
└─────────────┘      └──────────────┘      └──────────────┘      └─────────┘
                                                   │
                                                   ▼
                                            ┌──────────────┐
                                            │     RAID     │
                                            │  (download)  │
                                            └──────────────┘
```

## Features

- **Queue-based processing**: Polls `publish_jobs` table for pending jobs
- **Concurrent processing**: Configurable worker concurrency (default: 3)
- **Automatic retries**: Failed jobs retry up to 5 times with exponential backoff
- **Image optimization**: Creates WebP variants (400px thumb, 1600px display)
- **Graceful shutdown**: Completes in-flight jobs before stopping
- **CDN integration**: Uploads to B2 with CloudFlare CDN distribution

## Setup

### 1. Install Dependencies

```bash
cd worker
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and configure:

```bash
# Database
DATABASE_URL=postgresql://postgres:password@host:5432/postgres

# RAID Publisher
RAID_PUBLISHER_SECRET=your_raid_secret
RAID_PUB_ENDPOINT=https://raid.ibaproject.bid/pub/download

# B2 Storage
B2_KEY_ID=your_b2_key_id
B2_APP_KEY=your_b2_app_key
B2_BUCKET=IBA-Lot-Media
B2_ENDPOINT=s3.us-west-004.backblazeb2.com
B2_REGION=us-west-004

# CDN
CDN_BASE_URL=https://cdn.ibaproject.bid

# Worker
WORKER_POLL_INTERVAL=15000
MAX_RETRIES=5
LOG_LEVEL=info
CONCURRENCY=3
```

### 3. Local Development

```bash
npm run dev
```

### 4. Build for Production

```bash
npm run build
npm start
```

## Deployment

### Option 1: Railway

1. Create new project on [Railway](https://railway.app/)
2. Connect your Git repository
3. Set root directory to `/worker`
4. Add environment variables from `.env`
5. Deploy

**railway.toml** (optional):
```toml
[build]
builder = "nixpacks"
buildCommand = "npm install && npm run build"

[deploy]
startCommand = "npm start"
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 10
```

### Option 2: Render

1. Create new **Background Worker** on [Render](https://render.com/)
2. Connect repository
3. Set:
   - **Root Directory**: `worker`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: Starter (512MB RAM minimum)
4. Add environment variables
5. Deploy

### Option 3: DigitalOcean App Platform

1. Create new App
2. Choose your repository
3. Detect worker component
4. Configure:
   - **Source Directory**: `worker`
   - **Build Command**: `npm install && npm run build`
   - **Run Command**: `npm start`
5. Add environment variables
6. Deploy

### Option 4: Docker (Self-hosted)

**Dockerfile** (create in `/worker` directory):
```dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Start worker
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t media-worker .
docker run -d --env-file .env --name media-worker media-worker
```

### Option 5: PM2 (VPS)

```bash
npm install -g pm2

# Start worker
pm2 start dist/index.js --name media-worker

# Save PM2 configuration
pm2 save

# Set up startup script
pm2 startup
```

## Monitoring

### Health Checks

The worker logs all activity to stdout. Monitor logs for:
- Job processing status
- Error messages
- Retry attempts
- Database connection issues

### Key Metrics to Monitor

- **Job queue depth**: Number of pending jobs in `publish_jobs`
- **Processing rate**: Jobs completed per minute
- **Error rate**: Failed jobs / total jobs
- **Average processing time**: Time from job creation to completion

### Database Queries for Monitoring

```sql
-- Pending jobs count
SELECT COUNT(*) FROM publish_jobs WHERE status = 'pending';

-- Failed jobs needing attention
SELECT * FROM publish_jobs
WHERE status = 'failed' AND retry_count >= max_retries;

-- Average processing time
SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_seconds
FROM publish_jobs
WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '1 hour';

-- Publishing status summary
SELECT publish_status, COUNT(*)
FROM auction_files
WHERE deleted_at IS NULL
GROUP BY publish_status;
```

## Troubleshooting

### Worker not processing jobs

1. Check database connection:
   ```bash
   psql $DATABASE_URL -c "SELECT 1"
   ```

2. Verify jobs exist:
   ```sql
   SELECT * FROM publish_jobs WHERE status = 'pending' LIMIT 5;
   ```

3. Check worker logs for errors

### RAID download failures

- Verify `RAID_PUBLISHER_SECRET` is correct
- Test RAID endpoint manually:
  ```bash
  curl -H "Authorization: Bearer $RAID_PUBLISHER_SECRET" \
       "https://raid.ibaproject.bid/pub/download?key=test-key"
  ```

### B2 upload failures

- Verify B2 credentials:
  ```bash
  aws s3 ls s3://IBA-Lot-Media \
    --endpoint-url https://s3.us-west-004.backblazeb2.com \
    --region us-west-004
  ```

- Check bucket permissions (key must have write access)

### Image processing errors

- Ensure sufficient memory (minimum 512MB RAM)
- Check source image format is supported
- Review sharp library logs

## Performance Tuning

### Concurrency

Adjust `CONCURRENCY` based on:
- Available memory (each job uses ~100-200MB during processing)
- CPU cores (2-3x core count is reasonable)
- Network bandwidth

### Poll Interval

- **High load**: Reduce to 5000ms (5 seconds)
- **Low load**: Increase to 30000ms (30 seconds) to reduce database polling

### Retry Strategy

Modify in database migration if needed:
```sql
-- Increase max retries for flaky operations
UPDATE publish_jobs SET max_retries = 10 WHERE status = 'failed';
```

## Scaling

### Horizontal Scaling

Run multiple worker instances:
- Each worker polls independently
- `FOR UPDATE SKIP LOCKED` ensures no duplicate processing
- Safe to scale up/down at any time

### Vertical Scaling

For large images or high throughput:
- Increase memory allocation
- Use faster CPUs
- Consider SSD storage for temp files

## Security

- Database credentials use SSL by default
- RAID authentication via Bearer token
- B2 uses S3-compatible signed requests
- All environment variables kept secure
- No secrets in logs (redacted automatically)

## Maintenance

### Graceful Restart

The worker handles SIGTERM gracefully:
```bash
kill -TERM <pid>
```

Completes in-flight jobs before exiting.

### Database Cleanup

Completed jobs are kept for audit. Clean up old jobs periodically:
```sql
DELETE FROM publish_jobs
WHERE status = 'completed'
AND completed_at < NOW() - INTERVAL '90 days';
```

### Soft-deleted File Cleanup

Files are automatically purged 30 days after soft deletion via pg_cron. No manual intervention needed.

## Support

For issues, check:
1. Worker logs (stdout/stderr)
2. Database `publish_jobs` table for error messages
3. Edge function logs in Supabase dashboard
4. B2 bucket access logs
