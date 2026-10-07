# QRoll API reference

Base URL: `https://qroll-backend-five.vercel.app/api/v1`

- Send JSON bodies with `Content-Type: application/json`.
- Authenticated routes need `Authorization: Bearer <token>` (token from login/register).
- Errors come back as `{ "error": "message" }` with a matching HTTP status.
- Roles: `student`, `teacher`, `admin` (admins can use every teacher route on any course).

## Auth

| Method & path | Auth | Body / query | Returns |
| --- | --- | --- | --- |
| `POST /auth/register` | – | `name`, `email`, `password` (≥ 6), `role` (`student` \| `teacher`) | `201` `{ token, user, user_id }` |
| `POST /auth/login` | – | `email`, `password` | `{ token, user: { id, name, email, role } }` |
| `GET /auth/me` | any | – | `{ user }` |
| `PUT /auth/password` | any | `current_password`, `new_password` | `{ message }` |
| `POST /auth/forgot` | – | `email` | always `{ message }` (`503` if email isn't configured); sends a 30-minute single-use reset link |
| `POST /auth/reset` | – | `token`, `password` | `{ token, user }` — logs the user in |

Tokens last 7 days (`JWT_EXPIRES_IN`). Emails are case-insensitive.

## Courses

| Method & path | Auth | Body / query | Returns |
| --- | --- | --- | --- |
| `POST /courses/create` | teacher | `course_name`, `course_code` (unique, upper-cased) | `201` `{ course_id }` |
| `GET /courses/my-courses` | teacher | – | courses with `student_count`, `session_count`, `last_session_at` |
| `GET /courses/enrolled` | student | – | enrolled courses with `teacher_name`, `total_sessions`, `attended_sessions`, `percentage` |
| `POST /courses/enroll` | teacher (owner) | `course_id`, `student_email` (one, or many separated by comma / newline) | `{ message, enrolled[], already[], notFound[] }` |
| `GET /courses/:id/students` | teacher (owner) | – | students with attendance counts and `percentage` |
| `DELETE /courses/:id/students/:studentId` | teacher (owner) | – | `{ message }` (past attendance is kept) |
| `PUT /courses/:id` | teacher (owner) | `course_name`, `course_code` | `{ message }` |
| `DELETE /courses/:id` | teacher (owner) | `confirm_code` (must equal the course code) | `{ message, sessions, enrollments }` — deletes the course with its sessions, attendance and enrollments |

## Sessions

| Method & path | Auth | Body / query | Returns |
| --- | --- | --- | --- |
| `POST /sessions/start` | teacher (owner) | `course_id`, `expiry_minutes` (1–180) | `201` `{ session_id, token, qrImage (data URL), scan_url, expires_at, server_now, course_* }` |
| `GET /sessions/active` | teacher | – | sessions still open, with `present_count` |
| `GET /sessions/history` | teacher | `course_id` (optional) | last 200 sessions with `is_live`, `present_count`, `enrolled_count` |
| `PUT /sessions/:id/close` | teacher (owner) | – | `{ message }` |
| `GET /sessions/:id/live` | teacher (owner) | – | `{ count, students[], is_live, expires_at, server_now, enrolled_count }` |

A session is live while `is_active = 1` **and** `expires_at` is in the future; no background job is needed.
The QR encodes `${FRONTEND_URL}/scan?t=<token>`.

## Attendance

| Method & path | Auth | Body / query | Returns |
| --- | --- | --- | --- |
| `POST /attend/scan` | student | `token` (raw token or full scan URL), optional `lat`, `lng` | `{ message, course_name, course_code, marked_at }` — `404` unknown, `410` ended, `409` already marked |
| `GET /attend/my-history` | any | – | the caller's check-ins, newest first |
| `GET /attend/session/:id` | teacher (owner) | – | `{ session, students[] }` with `present: true/false` for every enrolled student |

Scanning a QR automatically enrols the student in that course.

## Reports

| Method & path | Auth | Body / query | Returns |
| --- | --- | --- | --- |
| `GET /reports/overview` | teacher | `tz` (minutes east of UTC, for "today") | `{ courses, students, sessions, scans_today, avg_attendance, threshold }` |
| `GET /reports/course/:id` | teacher (owner) | `from`, `to` (YYYY-MM-DD) or `from_ts`, `to_ts` (ISO instants) | per-student `total_sessions`, `attended_sessions`, `percentage`, `last_attended` |
| `GET /reports/course/:id/sessions` | teacher (owner) | – | per-session `present_count`, `enrolled_count`, `is_live` |
| `GET /reports/me/summary` | any | – | the caller's per-course attendance |
| `GET /reports/low-attendance` | teacher | – | students below the threshold (default 75 %) across the teacher's courses |
| `POST /reports/send-alerts/:course_id` | teacher (owner) | – | `{ message, sent, failed }` — emails every student below the threshold; `503` if email is not configured |

## Settings (feature switches)

| Method & path | Auth | Body / query | Returns |
| --- | --- | --- | --- |
| `GET /settings` | – | – | `{ features }` — every switch with its current value (admins always bypass switches) |
| `GET /settings/labels` | admin | – | human-readable label per switch |
| `PUT /settings/features` | admin | `{ features: { "<key>": true/false } }` | `{ message, features }` |

Switch keys: `teacher.stats`, `teacher.running_sessions`, `teacher.start_attendance`, `teacher.recent_sessions`,
`teacher.my_courses`, `teacher.needs_attention`, `teacher.page_courses`, `teacher.page_reports`,
`teacher.can_create_course`, `teacher.can_delete_course`, `teacher.can_email_alerts`, `student.overall`,
`student.my_courses`, `student.recent_checkins`, `student.low_warning`, `student.page_scan`,
`student.page_history`, `global.registration`, `global.registration_teacher`.
Off switches hide the panel/page in the app **and** are enforced by the API (`403`).

## Admin

All admin routes require the `admin` role. Accounts whose email is listed in the `ADMIN_EMAILS`
environment variable are promoted to admin automatically on register/login.

| Method & path | Body / query | Returns |
| --- | --- | --- |
| `GET /admin/overview` | `tz` | site-wide counts (`students`, `teachers`, `admins`, `courses`, `sessions`, `live_sessions`, `attendances`, `scans_today`, `new_users_week`) plus `recentUsers[]` and `recentSessions[]` |
| `GET /admin/users` | `role`, `q` | every account with `course_count`, `enrolled_count`, `attendance_count` |
| `GET /admin/teachers` | – | teachers (and admins) for dropdowns |
| `POST /admin/users` | `name`, `email`, `password`, `role` | `201` `{ user_id }` |
| `PUT /admin/users/:id` | any of `name`, `email`, `role`, `password` | `{ message }` — can't demote yourself or a teacher who still owns courses |
| `DELETE /admin/users/:id` | – | `{ message, attendances, courses }` — removes the user and everything they own (can't delete yourself) |
| `GET /admin/courses` | – | all courses with `teacher_name`, counts |
| `POST /admin/courses` | `course_name`, `course_code`, `teacher_id` | `201` `{ course_id }` |
| `PUT /admin/courses/:id` | `course_name`, `course_code`, `teacher_id` | `{ message }` — reassigns the course to another teacher |

Admins may also call every teacher route; `GET /courses/my-courses`, `/sessions/active`, `/sessions/history`,
`/reports/overview` and `/reports/low-attendance` then cover **all** teachers, and `DELETE /courses/:id` works on any course.

## Other

| Method & path | Returns |
| --- | --- |
| `GET /health` (also `/api/v1/health`) | `{ status: "ok", db: "ok", ms, time }` — `503` if the database is unreachable |
