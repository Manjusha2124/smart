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

The root `render.yaml` defines a Node web service and a persistent PostgreSQL database. No local Docker installation is needed for a Render deployment.

1. Push this project to a GitHub repository. Keep `.env` out of Git; it is ignored by `.gitignore`.
2. In Render, create a new Blueprint and connect that repository. Render reads `render.yaml` and provisions the web service and database.
3. When prompted, enter the owner email and a unique password of at least 12 characters and no more than 72 UTF-8 bytes. Enter these only in Render's private environment-variable form, never in GitHub or chat.
4. Wait for the deployment health check to pass, then open the service URL. On the first startup, the app creates the single owner account from those private settings. The owner's first login initializes the starter catalog.

The Blueprint generates the session secret and connects the database automatically. Subsequent service restarts do not change or recreate the owner account. The database plan is paid so data persists; check Render's current pricing before provisioning. Do not expose the database publicly or put passwords/database URLs in source control.

## Production boundaries

- Login sessions are server-side and use HTTP-only, same-site cookies. Passwords are hashed; use passwords with at least 12 characters and no more than 72 UTF-8 bytes. Account roles are assigned by the server. Render's internal PostgreSQL connection uses TLS with its self-signed internal certificate.
- The bootstrap command refuses to create a second admin. Student registration always creates a student account.
- Online UPI/card processing is intentionally disabled. Orders are placed for cash payment at pickup; do not collect card details in this app.
- Menu photos must use HTTPS image URLs. Local file uploads are not shared or persisted by the backend.
- Back up the PostgreSQL database before production use and periodically thereafter.
