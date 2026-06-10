# Railway Deployment - Quick Start Checklist

## Before You Start
Gather these credentials:

- [ ] **Supabase Database URL** (from Supabase dashboard)
- [ ] **RAID Publisher Secret** (from planner team)
- [ ] **B2 Key ID** (from Backblaze B2)
- [ ] **B2 App Key** (from Backblaze B2)

---

## Deployment Steps

### 1. Create Railway Project
- [ ] Go to https://railway.app
- [ ] Sign up/login with GitHub
- [ ] Click "+ New Project"

### 2. Prepare GitHub Repository
Choose one:

**Option A: New Repo**
```bash
cd /path/to/project
git init
git add .
git commit -m "Initial commit"
# Create repo at github.com/new, then:
git remote add origin https://github.com/YOUR_USERNAME/REPO_NAME.git
git branch -M main
git push -u origin main
```

**Option B: Existing Repo**
```bash
git add .
git commit -m "Add worker"
git push
```

### 3. Deploy on Railway
- [ ] In Railway, select "Deploy from GitHub repo"
- [ ] Select your repository
- [ ] Set Root Path to `/worker`
- [ ] Click "Deploy"

### 4. Add Environment Variables
Open Railway → Your Service → Variables tab

Copy from `.env.railway` file:
- [ ] DATABASE_URL
- [ ] RAID_PUBLISHER_SECRET
- [ ] RAID_PUB_ENDPOINT
- [ ] B2_KEY_ID
- [ ] B2_APP_KEY
- [ ] B2_BUCKET
- [ ] B2_ENDPOINT
- [ ] B2_REGION
- [ ] CDN_BASE_URL

### 5. Wait for Build
- [ ] Watch "Deployments" tab (2-3 minutes)
- [ ] Check "Logs" tab for startup message

### 6. Verify
- [ ] See "Media Publishing Worker started" in logs
- [ ] Create test job in your app
- [ ] Watch logs to see worker process it

---

## Need Help?
- Full guide: See `RAILWAY_DEPLOYMENT.md`
- Troubleshooting: Check Railway logs tab
- Worker config: See `.env.example`
