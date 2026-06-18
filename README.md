
# Smart Duka API

A production-ready REST API for the Smart Duka Point‑of‑Sale system. Built with Node.js, Express, MongoDB, and JWT authentication.

## Features

- Multi‑shop architecture – each shop has its own owner, staff, inventory, and sales.
- Role‑based access control (Owner / Staff) with granular permissions.
- Full CRUD for products, staff, and sales.
- Email verification for owners (6‑digit OTP).
- Password reset via OTP (6‑digit code sent by email).
- Sales are recorded atomically (transactions) to maintain stock integrity.
- Dashboard endpoints with aggregated data (sales, low stock alerts, stock value).
- Input validation with Joi – rejects unknown fields.
- Global error handling and async wrapper.

## Tech Stack

- Node.js (20+)
- Express.js
- MongoDB + Mongoose
- JWT (JSON Web Tokens)
- bcryptjs for password hashing
- Nodemailer for emails
- Joi for validation

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
| MONGO_URI | MongoDB connection string | `mongodb://localhost:27017/smart_duka` |
| JWT_SECRET | Secret for signing JWTs | `your_super_secret_key` |
| JWT_EXPIRES_IN | JWT expiration time | `7d` |
| BCRYPT_ROUNDS | Salt rounds for bcrypt | `10` |
| SMTP_HOST | SMTP server host | `smtp.gmail.com` |
| SMTP_PORT | SMTP port | `587` |
| SMTP_SECURE | Use TLS/SSL? (`true` for 465) | `false` |
| SMTP_USER | SMTP username | `your-email@gmail.com` |
| SMTP_PASS | SMTP password or app password | `xxxx xxxx xxxx xxxx` |
| SMTP_FROM | Sender email address | `"Smart Duka" <noreply@smartduka.com>` |

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

> Staff users do **not** see `costPrice`.

#### Get single product

```
GET /products/:id
```

**Headers:** `Authorization: Bearer <token>`

#### Create product (Owner only or staff with `create_product` permission)

```
POST /products
```

**Request body:**
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

**Response (201 Created):**
```json
{
  "success": true,
  "data": { "invoiceNumber": "INV-2506-00001", ... },
  "message": "Sale recorded successfully"
}
```

- Stock is reduced atomically (MongoDB transaction).
- Invoice number is auto‑generated.

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
    "recentTransactions": [ ... ]
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

Use Postman or any API client. Example collection: [Smart Duka API.postman_collection.json](./postman/collection.json)

## Deployment

1. Set environment variables on your hosting platform.
2. Use a process manager like **PM2** or run behind Nginx.
3. For production, enable CORS with specific origins:
```js
app.use(cors({ origin: 'https://yourfrontend.com' }));
```

## License

MIT

## Support

For issues, please create a ticket on the GitHub repository or contact support@smartduka.com.
