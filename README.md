# Bone Tide Co. — Backend API

Node.js + Express + Postgres. Deploy on Railway in ~10 minutes.

## Deploy steps

### 1. Create Railway project
1. Go to railway.app → New Project → Empty Project
2. Click "+ New" → GitHub Repo → connect this folder
   (or drag the folder into Railway's deploy interface)

### 2. Add Postgres
1. In your Railway project, click "+ New" → Database → PostgreSQL
2. Railway auto-sets DATABASE_URL in your environment

### 3. Run the schema
1. Click the Postgres plugin → Data tab → SQL Editor
2. Paste the contents of schema.sql and run it
3. You should see 6 new tables created

### 4. Add environment variables
In Railway → your service → Variables tab, add:

| Variable                | Where to get it |
|------------------------|-----------------|
| ANTHROPIC_API_KEY      | console.anthropic.com → API Keys |
| SHOPIFY_ADMIN_TOKEN    | Shopify admin → Settings → Apps & sales channels → Develop apps → Create app → Admin API |
| SHOPIFY_STORE_DOMAIN   | e.g. bonetideco.myshopify.com |
| SHOPIFY_WEBHOOK_SECRET | Shopify admin → Settings → Notifications → Webhooks → any webhook → signing secret |
| JWT_SECRET             | Any long random string |

DATABASE_URL and PORT are set automatically by Railway.

### 5. Deploy
Railway auto-deploys on every git push. First deploy takes ~2 minutes.
Your API URL will be something like: https://bonetide-api.up.railway.app

### 6. Wire into the app
In your app's btcApi.js, change:
```js
const BTC_API_BASE = 'https://bonetide-api.up.railway.app';
```

### 7. Register Shopify webhook
In Shopify admin → Settings → Notifications → Webhooks:
- Event: Order payment
- URL: https://bonetide-api.up.railway.app/webhooks/shopify/orders-paid
- Format: JSON

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET  | /health | Health check |
| POST | /api/identify | Claude Vision fish ID |
| POST | /api/catches | Log a catch |
| GET  | /api/catches | Fetch catch history |
| GET  | /api/tides | NOAA tide predictions |
| GET  | /api/conditions | Open-Meteo weather + marine |
| GET  | /api/rewards/profile | Points balance + tier |
| POST | /api/redeem | Generate Shopify discount code |
| POST | /webhooks/shopify/orders-paid | Confirm points deduction |

## Cost estimate at 1,000 active users/month
- Railway compute: ~$5/mo
- Railway Postgres: ~$5/mo
- Anthropic (fish scanner): ~$20-40/mo
- NOAA + Open-Meteo: free
- RainViewer: free up to 1k users
- **Total: ~$30-50/mo**
