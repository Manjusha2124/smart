# Smart Canteen

The application is served by its Node.js API. Orders, the menu, account roles, and staff permissions are stored in PostgreSQL; browser storage is used only for a student's cart and favourites.

## Local setup

Requirements: Node.js 20+ and Docker Desktop (for the included local PostgreSQL service).

1. Copy `.env.example` to `.env` and set a unique `SESSION_SECRET` (at least 32 characters), `BOOTSTRAP_ADMIN_EMAIL`, and `BOOTSTRAP_ADMIN_PASSWORD` (at least 12 characters and no more than 72 UTF-8 bytes). Keep `.env` private.
2. Start PostgreSQL with `docker compose up -d db`.
3. Install packages with `npm install`.
4. Start the app with `npm start`, then open `http://localhost:3000`. The first startup creates the owner account automatically if one does not already exist.

The first owner login imports the bundled starter menu once. It does not create sample users or known demo passwords. Students can register themselves; only an admin can create or disable staff accounts. Staff cannot change menu prices or create accounts.

Use the Node server URL, not a static-file server such as `python -m http.server`, because the static server cannot handle API requests.

## Render deployment

The root `render.yaml` defines a free Node web service. No local Docker installation is needed. To keep the database free without using Render's expiring 30-day free PostgreSQL, use Neon Free for PostgreSQL.

1. Create a free PostgreSQL project in [Neon](https://neon.tech/). Copy its pooled connection string and keep it private.
2. In [Render](https://dashboard.render.com/), create a new Blueprint and connect this GitHub repository. Render reads `render.yaml` and proposes a free web service.
3. In the private environment-variable prompts, enter the Neon connection string for `DATABASE_URL`, your owner email, and a unique owner password of at least 12 characters and no more than 72 UTF-8 bytes. Never enter secrets into GitHub or chat.
4. Confirm that the Blueprint lists **only the Free web service** and no paid resources, then deploy. Wait for the health check to pass and open the service URL.
5. On first startup, the app creates the owner account. The owner's first login initializes the starter catalog.

The Blueprint generates the session secret. Subsequent service restarts do not recreate the owner account. Neon Free is $0 with usage limits and scale-to-zero; Render Free sleeps after 15 minutes without traffic and can take about a minute to wake. Free-tier services are intended for prototypes and hobby projects, not a production canteen that requires continuous availability, guaranteed backups, or service-level commitments. Check both providers' current free-tier terms and usage before deploying. Do not expose the database publicly or put passwords/database URLs in source control.

## Production boundaries

- Login sessions are server-side and use HTTP-only, same-site cookies. Passwords are hashed; use passwords with at least 12 characters and no more than 72 UTF-8 bytes. Account roles are assigned by the server. Production database connections use TLS.
- The bootstrap command refuses to create a second admin. Student registration always creates a student account.
- Online UPI/card processing is intentionally disabled. Orders are placed for cash payment at pickup; do not collect card details in this app.
- Menu photos must use HTTPS image URLs. Local file uploads are not shared or persisted by the backend.
- Back up the PostgreSQL database before production use and periodically thereafter.
