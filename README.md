# QRoll API (backend)

REST API for [QRoll](https://github.com/YeasinFiyaz/qroll-frontend), a smart QR-code
attendance system for classes.

**Live:** https://qroll-backend-five.vercel.app — health check at `/health`

## Stack

Node.js, Express 5, MySQL (`mysql2`), JSON Web Tokens, bcrypt, `qrcode`, Nodemailer.

Runs in two modes from the same code:

- **Long-lived server** (`node index.js`) — Render, a VPS, or local development. Uses a small keep-alive connection pool.
- **Serverless** (`api/index.js` + `vercel.json`) — Vercel. Opens one database connection per request and closes it before the response is sent, so free MySQL hosts with a 5-connection limit are never exhausted.

## Setup

```bash
npm install
cp .env.example .env        # fill in the values
npm run init-db             # creates any missing tables (safe on an existing DB)
npm run dev                 # or: npm start
```

See [`.env.example`](.env.example) for every variable. The important ones:

| Variable | Purpose |
| --- | --- |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection (`DB_PORT`, `DB_SSL` optional) |
| `JWT_SECRET` | Secret used to sign login tokens |
| `FRONTEND_URL` | Allowed CORS origin(s), comma separated; also used to build QR links |
| `EMAIL_USER`, `EMAIL_PASS` | Gmail address + app password for low-attendance alerts (optional) |

## Endpoints

All routes are under `/api/v1`. Authenticated routes expect `Authorization: Bearer <token>`.
See [docs/API.md](docs/API.md) for request and response details.

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `PUT /auth/password` |
| Courses | `POST /courses/create`, `GET /courses/my-courses`, `GET /courses/enrolled`, `POST /courses/enroll`, `GET /courses/:id/students`, `DELETE /courses/:id/students/:studentId`, `PUT /courses/:id`, `DELETE /courses/:id` |
| Sessions | `POST /sessions/start`, `GET /sessions/active`, `GET /sessions/history`, `PUT /sessions/:id/close`, `GET /sessions/:id/live` |
| Attendance | `POST /attend/scan`, `GET /attend/my-history`, `GET /attend/session/:id` |
| Reports | `GET /reports/overview`, `GET /reports/course/:id`, `GET /reports/course/:id/sessions`, `GET /reports/me/summary`, `GET /reports/low-attendance`, `POST /reports/send-alerts/:course_id` |

## Database

Five tables: `users`, `courses`, `enrollments`, `sessions`, `attendances`
(see [`schema.sql`](schema.sql)). All timestamps are stored and compared in UTC.
