# Railway Deployment Guide - Step by Step

## Prerequisites Checklist
- [ ] Railway account created at https://railway.app
- [ ] GitHub account (for connecting repo)
- [ ] Database credentials from Supabase
- [ ] RAID Publisher secret
- [ ] Backblaze B2 credentials (KEY_ID and APP_KEY)

---

## STEP 1: Create Railway Project

1. Go to **https://railway.app**
2. Click **"Start a New Project"**
3. Sign in with GitHub
4. Click **"+ New Project"**
5. Select **"Deploy from GitHub repo"**

---

## STEP 2: Connect Your GitHub Repository

### Option A: If you DON'T have a GitHub repo yet

1. Initialize git in your project:
   ```bash
   git init
   git add .
   git commit -m "Initial commit - Media Publishing Worker"
   ```

2. Create a new GitHub repository:
   - Go to https://github.com/new
   - Name it: `auction-media-worker` (or your preferred name)
   - Keep it private
   - Don't initialize with README (we already have code)

3. Push your code:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/auction-media-worker.git
   git branch -M main
   git push -u origin main
   ```

### Option B: If you ALREADY have a GitHub repo

1. Make sure your code is pushed to GitHub:
   ```bash
   git add .
   git commit -m "Add media publishing worker"
   git push
   ```

---

## STEP 3: Deploy to Railway

1. In Railway, after selecting "Deploy from GitHub repo":
   - Select your repository
   - Railway will detect the `railway.toml` configuration automatically

2. Railway will ask which directory to deploy from:
   - **Root Path**: `/worker`
   - This tells Railway to deploy only the worker directory

---

## STEP 4: Configure Environment Variables

In your Railway project dashboard:

1. Click on your service
2. Go to **"Variables"** tab
3. Click **"+ New Variable"**

Add these variables one by one:

### Database Configuration
```
DATABASE_URL=postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-us-west-1.pooler.supabase.com:6543/postgres
```
*(Get this from your Supabase dashboard → Settings → Database → Connection string → URI)*

### RAID Publisher Configuration
```
RAID_PUBLISHER_SECRET=your_raid_secret_from_planner_team
RAID_PUB_ENDPOINT=https://raid.ibaproject.bid/pub/download
```

### B2 Storage Configuration
```
B2_KEY_ID=your_b2_key_id_here
B2_APP_KEY=your_b2_app_key_here
B2_BUCKET=IBA-Lot-Media
B2_ENDPOINT=s3.us-west-004.backblazeb2.com
B2_REGION=us-west-004
```

### CDN Configuration
```
CDN_BASE_URL=https://cdn.ibaproject.bid
```

### Worker Configuration (Optional - uses defaults if not set)
```
WORKER_POLL_INTERVAL=15000
MAX_RETRIES=5
LOG_LEVEL=info
CONCURRENCY=3
```

---

## STEP 5: Deploy

1. After adding all environment variables, Railway will automatically trigger a deployment
2. Watch the build logs in the **"Deployments"** tab
3. Build should take 2-3 minutes

---

## STEP 6: Verify Deployment

1. Check the **"Logs"** tab - you should see:
   ```
   Media Publishing Worker started
   Polling for jobs every 15000ms
   ```

2. In your main application, create a test media publishing job
3. Watch the Railway logs to see the worker pick it up and process it

---

## Troubleshooting

### Build fails with "Cannot find module"
- Ensure `package.json` dependencies are correct
- Railway will run `npm install` automatically

### Worker starts but immediately crashes
- Check environment variables are set correctly
- Verify DATABASE_URL is the pooler connection string (port 6543)
- Check logs for specific error messages

### Worker doesn't pick up jobs
- Verify database connection by checking logs
- Ensure the media_publishing_jobs table exists
- Check that RAID_PUBLISHER_SECRET is correct

---

## Cost Estimation

Railway pricing (as of 2025):
- **Hobby Plan**: $5/month
  - 500 execution hours included
  - $0.000231/GB-hour for memory
  - This worker should easily fit within the hobby plan

- **Pro Plan**: $20/month if you need more resources

---

## Post-Deployment

After successful deployment:
1. Monitor logs for the first few hours
2. Test with a few media publishing jobs
3. Verify images appear correctly on CDN
4. Check that cleanup jobs run successfully

---

## Updating the Worker

To deploy updates:
```bash
git add .
git commit -m "Update worker"
git push
```

Railway will automatically detect changes and redeploy.
