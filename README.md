# Smart Duka Backend

Backend API for Smart Duka, a simple inventory and sales management system designed for small shops in Kenya.

## Overview

Smart Duka helps shop owners digitize inventory tracking and sales recording. The first version focuses on two core business operations:

* Inventory Management
* Sales Management

The system supports two user roles:

* Owner (Admin)
* Staff (Attendant)

Owners have full control over products, staff, and business records, while staff can record sales and view limited information required for daily operations.

---

## Features

### Authentication & Authorization

* Owner registration
* User login
* JWT authentication
* Role-based access control
* Password hashing with bcrypt
* Account activation/deactivation

### Inventory Management

* Add products
* Edit products
* Archive products
* Update stock quantities
* View product details
* Search products
* Filter products by category
* Low stock monitoring

### Sales Management

* Record sales
* Support multiple products per sale
* Cash transactions
* M-Pesa transactions
* Automatic stock deduction
* Sales history
* Personal sales history for staff
* Sales filtering by date and payment method

### Dashboard

#### Owner Dashboard

* Today's sales
* Cash sales total
* M-Pesa sales total
* Total products
* Current stock value
* Low stock products
* Recent transactions

#### Staff Dashboard

* Today's sales
* Cash sales total
* M-Pesa sales total
* Number of transactions
* Recent personal sales

### Staff Management

* Add staff
* Edit staff information
* Activate/deactivate staff accounts
* Reset staff passwords

### Profile Management

* View profile
* Update profile
* Change password

### Shop Management

* Manage shop information
* Shop name
* Phone number
* Location
* Currency settings

---

## Technology Stack

* Node.js
* Express.js
* MongoDB
* Mongoose
* JWT Authentication
* Bcrypt
* Joi Validation

---

## Project Structure

```text
src/
│
├── config/
│   └── db.js
│
├── controllers/
│   ├── auth.controller.js
│   ├── dashboard.controller.js
│   ├── product.controller.js
│   ├── sales.controller.js
│   ├── staff.controller.js
│   ├── profile.controller.js
│   └── shop.controller.js
│
├── middleware/
│   ├── auth.middleware.js
│   ├── role.middleware.js
│   ├── validation.middleware.js
│   └── error.middleware.js
│
├── models/
│   ├── User.js
│   ├── Product.js
│   ├── Sale.js
│   └── Shop.js
│
├── routes/
│   ├── auth.routes.js
│   ├── dashboard.routes.js
│   ├── product.routes.js
│   ├── sales.routes.js
│   ├── staff.routes.js
│   ├── profile.routes.js
│   └── shop.routes.js
│
├── services/
│   ├── auth.service.js
│   ├── dashboard.service.js
│   ├── product.service.js
│   ├── sales.service.js
│   └── staff.service.js
│
├── validations/
│   ├── auth.validation.js
│   ├── product.validation.js
│   ├── sales.validation.js
│   └── staff.validation.js
│
├── utils/
│   ├── generateToken.js
│   └── constants.js
│
├── app.js
└── server.js
```

---

## User Roles

### Owner

Permissions:

* Full system access
* Manage products
* Manage stock
* Manage staff
* View all sales
* View dashboard analytics
* Manage shop settings

### Staff

Permissions:

* Record sales
* View available products
* View stock levels
* View personal sales history
* View daily sales summary

Restrictions:

* Cannot manage products
* Cannot manage staff
* Cannot access business analytics
* Cannot view product cost prices

---

## API Endpoints

### Authentication

```http
POST /api/auth/register
POST /api/auth/login
```

---

### Dashboard

```http
GET /api/dashboard
```

Returns dashboard data based on the authenticated user's role.

---

### Shop

```http
GET /api/shop
PUT /api/shop
```

---

### Staff Management (Owner Only)

```http
GET /api/staff
POST /api/staff
PUT /api/staff/:id
POST /api/staff/:id/reset-password
```

---

### Products

```http
GET /api/products
GET /api/products/:id
POST /api/products
PUT /api/products/:id
PATCH /api/products/:id/stock
PATCH /api/products/:id/archive
```

---

### Sales

```http
POST /api/sales
GET /api/sales
GET /api/sales/:id
GET /api/sales/me
```

---

### Profile

```http
GET /api/profile
PUT /api/profile
POST /api/profile/change-password
```

---

## Database Models

### User

```javascript
{
  name: String,
  phone: String,
  password: String,
  role: "owner" | "staff",
  isActive: Boolean
}
```

### Product

```javascript
{
  name: String,
  category: String,
  costPrice: Number,
  sellingPrice: Number,
  quantity: Number,
  lowStockAlert: Number,
  isArchived: Boolean
}
```

### Sale

```javascript
{
  saleNumber: String,
  recordedBy: ObjectId,
  paymentMethod: "cash" | "mpesa",
  totalAmount: Number,
  items: [
    {
      productId: ObjectId,
      productName: String,
      quantity: Number,
      unitPrice: Number,
      subtotal: Number
    }
  ]
}
```

### Shop

```javascript
{
  shopName: String,
  phone: String,
  location: String,
  currency: String
}
```

---

## Environment Variables

Create a `.env` file in the project root.

```env
PORT=5000

MONGO_URI=mongodb://localhost:27017/smart-duka

JWT_SECRET=your_super_secret_key
```

---

## Installation

### Clone Repository

```bash
git clone <repository-url>
cd smart-duka-backend
```

### Install Dependencies

```bash
npm install
```

### Configure Environment

Create a `.env` file using the example above.

### Start Development Server

```bash
npm run dev
```

### Start Production Server

```bash
npm start
```

---

## Business Rules

### Recording Sales

When a sale is recorded:

1. Validate products exist.
2. Validate stock availability.
3. Deduct stock quantities.
4. Create sale record.
5. Save transaction atomically.

### Staff Restrictions

Staff users:

* Cannot edit inventory
* Cannot delete products
* Cannot manage staff
* Cannot access owner analytics
* Cannot view product cost prices

### Low Stock Alert

A product is considered low in stock when:

```text
quantity <= lowStockAlert
```

---

## Future Improvements

* Expense Management
* Profit Tracking
* Supplier Management
* Customer Management
* M-Pesa Daraja Integration
* PDF Reports
* Excel Export
* Offline Support
* Multi-Branch Support
* Barcode Scanning
* Notifications

---

## License

MIT License

---

## Smart Duka

Simple inventory and sales management for small businesses in Kenya.
