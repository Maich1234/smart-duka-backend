
# Dukana API

A production-ready REST API for the Dukana Point‑of‑Sale system. Built with Node.js, Express, MongoDB, and JWT authentication.

## Features

- Multi‑shop architecture – each shop has its own owner, staff, inventory, and sales.
- Role‑based access control (Owner / Staff) with granular permissions.
- Full CRUD for products, staff, and sales.
- **Flexible product pricing** – standard, variable (negotiable), weighted/refillable (per kg/L), service, bundle, and configurable (variant) products, all priced and stock‑deducted correctly through a single pricing engine.
- **QR receipt verification & customer ratings** – every sale gets a stateless, signed receipt token; customers scan a QR code on the receipt to verify authenticity and rate their service, visible in shop analytics.
- **Inventory depletion analytics** – sales‑velocity‑based stockout prediction and fast/slow‑mover classification (not just a static low‑stock threshold).
- **Intelligent push notifications (FCM)** – daily sales‑vs‑historical‑average anomaly alerts and predictive low‑stock alerts, delivered via scheduled cron jobs to each shop's owner only.
- Email verification for owners (6‑digit OTP).
- Password reset via OTP (6‑digit code sent by email).
- Sales are recorded atomically (transactions) to maintain stock integrity.
- **Sale voiding & refunds** – owners (or staff granted the permission) can void mis-recorded sales or refund customers. M-Pesa sales are refunded straight back to the customer via Safaricom's Transaction Reversal API (async, settled by result webhook); any sale can be refunded in cash. Both restore stock and drop out of every revenue aggregate. Staff refund rights are granular: `refund_own_sales` vs `refund_all_sales` (the latter auto-grants `view_all_sales`).
- Dashboard endpoints with aggregated data (sales, low stock alerts, stock value, ratings).
- Input validation with Joi – rejects unknown fields.
- Global error handling and async wrapper.
- HTTP request logging with Morgan (`dev` format in development, `combined` in production).
- Rate‑limited public endpoints for unauthenticated receipt verification/rating.

## Tech Stack

- Node.js (20+)
- Express.js
- MongoDB + Mongoose
- JWT (JSON Web Tokens)
- bcryptjs for password hashing
- Nodemailer for emails
- Joi for validation
- Morgan for HTTP request logging
- firebase-admin – Firebase Cloud Messaging (push notifications)
- express-rate-limit – rate limiting for public endpoints
- Vercel Cron Jobs – scheduled daily-sales-check and depletion-alerts (see `vercel.json`)

## Getting Started

### Prerequisites

- Node.js 20+
- MongoDB (local or Atlas)
- SMTP account (e.g., Gmail, SendGrid) for sending OTP & verification emails

### Installation

1. Clone the repository
```bash
git clone https://github.com/yourusername/smart-duka-api.git
cd smart-duka-api
```

2. Install dependencies
```bash
npm install
```

3. Copy the environment variables file
```bash
cp .env.example .env
```

4. Edit `.env` with your own values (see below).

5. Start the server
```bash
npm run dev       # development (nodemon)
npm start         # production
```

The server will run on `http://localhost:5000` by default.

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| PORT | Server port | 5000 |
| NODE_ENV | Environment mode; also controls Morgan log format (`combined` in production, `dev` otherwise) | `development` |
| MONGO_URI | MongoDB connection string | `mongodb://localhost:27017/smart_duka` |
| JWT_SECRET | Secret for signing JWTs | `your_super_secret_key` |
| JWT_EXPIRES_IN | JWT expiration time | `7d` |
| BCRYPT_ROUNDS | Salt rounds for bcrypt | `10` |
| SMTP_HOST | SMTP server host | `smtp.gmail.com` |
| SMTP_PORT | SMTP port | `587` |
| SMTP_SECURE | Use TLS/SSL? Defaults to `true` when `SMTP_PORT` is `465`, `false` otherwise, if unset | `false` |
| SMTP_USER | SMTP username | `your-email@gmail.com` |
| SMTP_PASS | SMTP password or app password | `xxxx xxxx xxxx xxxx` |
| SMTP_FROM | Sender address. Must contain a real address, and in a `.env` needs outer single quotes or the display name swallows the value — see note below | `'"Dukana" <noreply@dukana.com>'` |
| RECEIPT_TOKEN_SECRET | HMAC/JWT signing secret for receipt QR-verification tokens | `a-long-random-string` |
| CRON_SECRET | Shared secret Vercel Cron sends as `Authorization: Bearer <CRON_SECRET>` to the `/cron/*` endpoints | `another-long-random-string` |
| PUBLIC_WEB_URL | Base URL of the deployed public web app; used to build the QR code link on receipts | `https://app.dukana.co.ke` |
| FIREBASE_PROJECT_ID | Firebase project ID (Admin SDK service account) | `smart-duka-64d5c` |
| FIREBASE_CLIENT_EMAIL | Firebase Admin SDK service account email | `firebase-adminsdk-xxxxx@smart-duka-64d5c.iam.gserviceaccount.com` |
| FIREBASE_PRIVATE_KEY | Firebase Admin SDK service account private key (keep the `\n` escape sequences, wrap in quotes) | `"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"` |
| MPESA_CALLBACK_URL | Public HTTPS URL Safaricom POSTs STK Push results to | `https://api.dukana.co.ke/api/v1/mpesa/callback` |
| MPESA_REVERSAL_RESULT_URL | (Optional) Public HTTPS URL for Transaction Reversal (refund) results; defaults to `MPESA_CALLBACK_URL` with `/callback` → `/reversal-result` | `https://api.dukana.co.ke/api/v1/mpesa/reversal-result` |

> `RECEIPT_TOKEN_SECRET`/`CRON_SECRET`/`FIREBASE_*` are optional for local development — the server still boots and every other feature works without them. Receipt QR codes won't verify and push notifications are silently skipped (with a console warning) until they're set.

> **`SMTP_FROM` quoting.** In a `.env` file, `SMTP_FROM="Dukana" <noreply@example.com>` parses to just `Dukana` — the quoted display name terminates the value and the address is dropped. Nodemailer then has no address to use and sends `MAIL FROM:<>`, a null return-path that receivers treat as a bounce and spam-file or reject. Wrap the whole value in single quotes (`SMTP_FROM='"Dukana" <noreply@example.com>'`) or leave it unquoted. Dashboard-set env vars (Vercel) aren't parsed this way, so paste the plain `"Dukana" <noreply@example.com>` form there. `sendEmail` defends against the mistake by falling back to `SMTP_USER` as the address, but fix the variable rather than relying on that.

## Authentication

All endpoints except `/auth/login`, `/auth/register`, and the password reset endpoints require a **Bearer token** in the `Authorization` header.

```
Authorization: Bearer <jwt_token>
```

The JWT payload contains the user’s `id`. The server attaches the full user object (including role, shop, permissions) to `req.user` after verifying the token.

## API Endpoints

### Base URL

```
http://localhost:5000/api/v1
```

### Auth

#### Register a new owner (with shop)

```
POST /auth/register
```

**Request body:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "secure123",
  "shopName": "John's Duka",
  "address": "Nairobi, Kenya",      // optional
  "phone": "+254712345678"          // optional
}
```

**Response (201 Created):**
```json
{
  "success": true,
  "message": "Registration successful. Please check your email to verify your account."
}
```

> The owner receives a 6‑digit verification code by email. They must verify before logging in.

#### Login

```
POST /auth/login
```

**Request body:**
```json
{
  "email": "john@example.com",
  "password": "secure123"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "_id": "65b8...",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "owner",
    "shop": { "_id": "...", "name": "John's Duka" },
    "token": "eyJhbGci..."
  }
}
```

#### Resend verification email

```
POST /auth/resend-verification
```

**Headers:** `Authorization: Bearer <token>`

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Verification code sent. Please check your email."
}
```

#### Resend verification email (unauthenticated)

```
POST /auth/resend-verification-email
```

**Request body:**
```json
{
  "email": "john@example.com"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Verification code sent. Please check your email."
}
```

> Use this when the original verification code expires before the user can log in (unverified users can't authenticate, so the token‑based `/auth/resend-verification` above is unreachable for them). Invalidates any previous code and issues a new one.

#### Verify email

```
POST /auth/verify-email
```

**Request body:**
```json
{
  "email": "john@example.com",
  "code": "123456"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Email verified successfully. You can now log in."
}
```

#### Forgot password – request OTP

```
POST /auth/forgot-password
```

**Request body:**
```json
{
  "email": "john@example.com"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "OTP sent to your email"
}
```

#### Verify OTP

```
POST /auth/verify-otp
```

**Request body:**
```json
{
  "email": "john@example.com",
  "otp": "654321"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "OTP verified"
}
```

#### Reset password

```
POST /auth/reset-password
```

**Request body:**
```json
{
  "email": "john@example.com",
  "otp": "654321",
  "newPassword": "newSecure123"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Password reset successfully"
}
```

#### Get current user profile

```
GET /auth/profile
```

**Headers:** `Authorization: Bearer <token>`

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "name": "John Doe",
    "email": "john@example.com",
    "role": "owner",
    "shop": { "_id": "...", "name": "John's Duka", "address": "...", "phone": "..." }
  }
}
```

#### Update profile

```
PUT /auth/profile
```

**Headers:** `Authorization: Bearer <token>`

**Request body:**
```json
{
  "name": "John Updated",
  "email": "newemail@example.com",
  "phone": "+254700000001"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": { ... }
}
```

#### Change password (authenticated)

```
POST /auth/change-password
```

**Headers:** `Authorization: Bearer <token>`

**Request body:**
```json
{
  "currentPassword": "secure123",
  "newPassword": "newSecure456"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

#### Register device for push notifications

```
POST /auth/device-token
```

**Headers:** `Authorization: Bearer <token>`

**Request body:**
```json
{ "token": "<fcm-device-token>" }
```

> Adds the token to the user's `fcmTokens` (deduplicated). Only `owner` accounts ever actually receive pushes (sales-anomaly/low-stock alerts), but any authenticated user can register.

#### Unregister device

```
DELETE /auth/device-token
```

**Headers:** `Authorization: Bearer <token>`

**Request body:**
```json
{ "token": "<fcm-device-token>" }
```

### Products

All endpoints are scoped to the authenticated user’s shop.

#### Get all products (with pagination, search, filter)

```
GET /products?search=maize&category=grains&page=1&limit=20
```

**Headers:** `Authorization: Bearer <token>`

**Response (200 OK):**
```json
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "pages": 3
  }
}
```

> Staff users do **not** see `costPrice` (including per-variant `costPrice` on configurable products).

#### Get single product

```
GET /products/:id
```

**Headers:** `Authorization: Bearer <token>`

#### Create product (Owner only or staff with `create_product` permission)

```
POST /products
```

**`productType`** (default `standard`) controls which fields are required/allowed — validated with conditional Joi rules so existing `standard` clients need no changes:

| productType | Extra fields | Pricing/stock behavior |
|---|---|---|
| `standard` | — | today's behavior: fixed `sellingPrice`, integer qty, 1:1 stock deduction |
| `variable` | `minPrice`, `maxPrice` (optional) | staff can override unit price at checkout, clamped to bounds if set |
| `weighted` / `refillable` | `unitOfMeasure` (`kg`\|`g`\|`l`\|`ml`) | `sellingPrice` = price per unit; decimal quantities allowed (e.g. 0.5 kg) |
| `service` | `allowPriceOverride`, `trackInventory` | no stock check/deduction when `trackInventory: false`; price may be overridden if allowed |
| `bundle` | `bundleItems: [{ product, quantity }]` | flat combo price; deducts each component's stock, not the bundle's own |
| `configurable` | `variants: [{ name, sellingPrice, costPrice, quantity, sku?, lowStockAlert }]` | price/stock resolved per selected variant at sale time |

**Request body (standard, unchanged):**
```json
{
  "name": "Maize Flour 2kg",
  "category": "grains",
  "sellingPrice": 250,
  "costPrice": 220,
  "quantity": 50,
  "lowStockAlert": 5
}
```

**Request body (bundle example):**
```json
{
  "name": "Breakfast Combo",
  "category": "combos",
  "productType": "bundle",
  "sellingPrice": 350,
  "costPrice": 280,
  "bundleItems": [
    { "product": "<breadProductId>", "quantity": 1 },
    { "product": "<milkProductId>", "quantity": 1 }
  ]
}
```

> A one-time backfill migration (`scripts/migrate-product-types.js`) sets `productType: 'standard'` on any product created before this feature shipped — run it once after deploying (`node scripts/migrate-product-types.js`). Safe to re-run; only touches documents missing the field.

#### Update product (Owner only or staff with `edit_product` permission)

```
PUT /products/:id
```

#### Delete product (Owner only or staff with `delete_product` permission)

```
DELETE /products/:id
```

#### Update stock quantity (Owner only or staff with `edit_product_stock` permission)

```
PATCH /products/:id/stock
```

**Request body:**
```json
{
  "quantity": 30
}
```

### Sales

#### Record a sale

```
POST /sales
```

**Headers:** `Authorization: Bearer <token>`

**Request body:**
```json
{
  "items": [
    { "productId": "65b8...", "quantity": 2 },
    { "productId": "65b9...", "quantity": 1 }
  ],
  "paymentMethod": "cash"
}
```

Per-item fields beyond `productId`/`quantity` are only needed for non-`standard` product types:

| Field | Used for | Notes |
|---|---|---|
| `quantity` | all types | decimal allowed only for `weighted`/`refillable`; integer enforced for everything else |
| `unitPrice` | `variable`, `service` (with `allowPriceOverride`) | overrides the product's `sellingPrice`, validated against `minPrice`/`maxPrice` if set |
| `variantId` | `configurable` | required — selects which variant's price/stock to use |

**Response (201 Created):**
```json
{
  "success": true,
  "data": { "invoiceNumber": "INV-2506-00001", "receiptToken": "eyJhbGci...", ... },
  "message": "Sale recorded successfully"
}
```

- Stock is reduced atomically (MongoDB transaction), via `src/services/pricingEngine.js` which dispatches per `productType` (handles bundle component deduction and configurable variant deduction too).
- Invoice number is auto‑generated.
- `receiptToken` (also returned by `GET /sales/:id`) is a stateless signed token — not stored — used to build the receipt QR code; see [Public Endpoints](#public-endpoints-unauthenticated) below.

#### Get sales (with filters, pagination)

```
GET /sales?startDate=2025-01-01&endDate=2025-01-31&staffId=...&paymentMethod=cash&page=1&limit=20
```

**Headers:** `Authorization: Bearer <token>`

- Owner sees all sales (can filter by staff).
- Staff sees only their own sales, unless granted `view_all_sales` permission.

#### Get my sales (staff personal sales)

```
GET /sales/me
```

**Headers:** `Authorization: Bearer <token>`

#### Get sale by ID

```
GET /sales/:id
```

**Headers:** `Authorization: Bearer <token>`

### Staff Management (Owner only)

#### Get all staff of the shop

```
GET /staff?search=john
```

**Headers:** `Authorization: Bearer <token>`

#### Get single staff

```
GET /staff/:id
```

#### Create staff

```
POST /staff
```

**Request body:**
```json
{
  "name": "Jane Staff",
  "email": "jane@example.com",
  "password": "staff123",
  "phone": "+254711223344"
}
```

#### Update staff

```
PUT /staff/:id
```

**Request body (any fields allowed):**
```json
{
  "name": "Jane Updated",
  "isActive": true,
  "phone": "+254700000000"
}
```

#### Reset staff password

```
POST /staff/:id/reset-password
```

**Request body:**
```json
{
  "newPassword": "newPass456"
}
```

#### Delete staff

```
DELETE /staff/:id
```

#### Get staff’s sales

```
GET /staff/:id/sales?startDate=...&endDate=...
```

#### Update staff permissions

```
PUT /staff/:id/permissions
```

**Request body:**
```json
{
  "permissions": ["view_products", "record_sale", "view_sales"]
}
```

#### Get all available permissions (list of hardcoded permissions)

```
GET /staff/permissions
```

**Response:**
```json
{
  "success": true,
  "data": [
    { "value": "view_products", "label": "View Products", "category": "Products" },
    { "value": "create_product", "label": "Create Product", "category": "Products" },
    ...
  ]
}
```

### Dashboard

#### Owner dashboard

```
GET /dashboard/owner
```

**Headers:** `Authorization: Bearer <token>` (owner only)

**Response:**
```json
{
  "success": true,
  "data": {
    "todaySalesTotal": 12500,
    "cashSalesTotal": 7500,
    "mpesaSalesTotal": 5000,
    "transactionsToday": 12,
    "totalProducts": 34,
    "currentStockValue": 45600,
    "lowStockItems": [ { "_id": "...", "name": "Sugar", "quantity": 2 } ],
    "recentTransactions": [ ... ],
    "ratingSummary": { "avgStars": 4.6, "totalRatings": 38 }
  }
}
```

#### Staff dashboard

```
GET /dashboard/staff
```

**Headers:** `Authorization: Bearer <token>` (staff only)

**Response:**
```json
{
  "success": true,
  "data": {
    "todaySalesTotal": 3200,
    "cashSalesTotal": 2000,
    "mpesaSalesTotal": 1200,
    "transactionsToday": 5,
    "recentSales": [ ... ]
  }
}
```

### Shop Configuration

#### Get shop settings

```
GET /shop
```

**Headers:** `Authorization: Bearer <token>`

#### Update shop settings (Owner only)

```
PUT /shop
```

**Request body:**
```json
{
  "name": "My New Shop Name",
  "address": "New Address",
  "phone": "+254722000000",
  "email": "new@shop.com",
  "taxRate": 16
}
```

### Public Endpoints (unauthenticated)

Reached by scanning the QR code printed on a receipt. Rate-limited (30 requests / 15 min / IP) since there's no auth layer to lean on.

#### Verify a receipt

```
GET /public/receipt/:token
```

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "invoiceNumber": "INV-2506-00001",
    "shopName": "John's Duka",
    "currency": "KES",
    "totalAmount": 720,
    "itemCount": 2,
    "createdAt": "2026-06-19T...",
    "alreadyRated": false,
    "rating": null
  }
}
```

#### Submit a rating for a receipt

```
POST /public/receipt/:token/rating
```

**Request body:**
```json
{ "stars": 5, "comment": "Great service!" }
```

> One rating per sale — idempotent: re-submitting for an already-rated receipt returns the existing rating instead of erroring. `stars` must be a whole number 1–5.

### Ratings (Owner only)

#### List ratings

```
GET /ratings?staffId=...&stars=5&page=1&limit=20
```

#### Ratings summary

```
GET /ratings/summary
```

**Response:**
```json
{
  "success": true,
  "data": {
    "avgStars": 4.6,
    "totalRatings": 38,
    "distribution": [ { "stars": 5, "count": 30 }, { "stars": 4, "count": 6 }, ... ],
    "byStaff": [ { "staffId": "...", "staffName": "Jane", "avgStars": 4.8, "totalRatings": 20 } ]
  }
}
```

### Analytics (Owner only)

#### Inventory depletion

```
GET /analytics/depletion?windowDays=30
```

Computes per-product sales velocity over a rolling window (default 30 days) and predicts stockout dates — used for fast/slow-mover classification and is the same logic the `depletion-alerts` cron job uses to decide what to notify about (not the static `lowStockAlert` field).

**Response:**
```json
{
  "success": true,
  "data": {
    "windowDays": 30,
    "items": [
      {
        "productId": "...",
        "name": "Water Refill",
        "quantity": 905,
        "unitsSold": 95,
        "avgDailyVelocity": 3.17,
        "daysUntilStockout": 285.8,
        "movement": "fast"
      }
    ],
    "fastMovers": [ ... ],
    "slowMovers": [ ... ],
    "stockoutSoon": [ ... ]
  }
}
```

### Cron (Vercel Cron only)

Not reachable by normal API clients — gated by a shared secret instead of `protect`. Vercel automatically sends `Authorization: Bearer $CRON_SECRET` to scheduled requests when `CRON_SECRET` is set as an env var (see `vercel.json`).

```
GET /cron/daily-sales-check     # compares today's sales to the trailing 14-day average per shop (z-score), pushes an anomaly alert to the owner if |z| > 1.5
GET /cron/depletion-alerts      # pushes a low-stock alert for products projected to run out within 3 days
```

Both are idempotent per `(shop, day)` via the `NotificationLog` collection — safe if Vercel retries a cron invocation.

## Error Handling

All errors return a consistent JSON object with the appropriate HTTP status code.

**Example (400 Bad Request):**
```json
{
  "success": false,
  "message": "Validation error",
  "errors": [ "email must be a valid email", "password is required" ]
}
```

**Common status codes:**

| Code | Description |
|------|-------------|
| 200  | OK |
| 201  | Created |
| 400  | Bad request (validation or business logic) |
| 401  | Unauthorized (missing or invalid token) |
| 403  | Forbidden (role/permission denied) |
| 404  | Not found |
| 500  | Internal server error |

## Validation

All endpoints validate input using **Joi** and reject any unknown fields (`unknown(false)`). This prevents unwanted field injection (e.g., `role` or `shop`).

## Email Templates

The API sends HTML emails for:
- Email verification (6‑digit code)
- Password reset OTP

The HTML templates are responsive and include a plain‑text fallback.

## Permissions System

Default staff permissions:
```js
['view_products', 'record_sale', 'view_sales']
```

Full permission list (owner can assign any combination):

| Permission | Description |
|------------|-------------|
| `view_products` | View product list and details |
| `create_product` | Create new products |
| `edit_product` | Edit product details |
| `delete_product` | Delete products |
| `edit_product_stock` | Update product stock quantity |
| `view_sales` | View own sales |
| `record_sale` | Create a sale |
| `view_all_sales` | View all shop sales (all staff) |
| `manage_staff` | Manage staff (not used; owner only) |
| `edit_shop_settings` | Edit shop settings (not used; owner only) |

## Testing

Use Postman or any API client. Example collection: [Dukana API.postman_collection.json](./postman/collection.json)

## Deployment

1. Set environment variables on your hosting platform — including `RECEIPT_TOKEN_SECRET`, `CRON_SECRET`, `PUBLIC_WEB_URL`, and the `FIREBASE_*` Admin SDK credentials if you want receipt QR verification and push notifications to work.
2. Use a process manager like **PM2** or run behind Nginx — or deploy as-is to Vercel (this project ships a `vercel.json` with `builds`/`routes` for serverless functions and a `crons` block for the two scheduled jobs in [Cron](#cron-vercel-cron-only)). On Vercel, setting the `CRON_SECRET` env var makes it auto-attach the matching `Authorization: Bearer` header to cron-triggered requests — no extra config needed.
3. For production, enable CORS with specific origins:
```js
app.use(cors({ origin: 'https://yourfrontend.com' }));
```
4. After deploying for the first time with this feature set, run the one-time backfill once against your production database: `node scripts/migrate-product-types.js`.

## License

MIT

## Support

For issues, please create a ticket on the GitHub repository or contact support@dukana.com.
# smart-duka

  
end
# smart-duka-web
