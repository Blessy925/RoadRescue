# Hospital registration and dispatch

## Start the app

Use Node.js 22 or newer (the server uses Node's built-in SQLite support). Copy `.env.example` to `.env`, set a private administrator token, then run:

```powershell
$env:HOSPITAL_ADMIN_TOKEN = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
npm run dev
```

The app stores hospitals, users, emergency requests, and ambulances in `data/roadrescue.sqlite` by default. Set `ROADRESCUE_DATABASE` to use another SQLite file. On first startup, existing JSON data files are imported; existing hospital passwords are converted to salted scrypt hashes and removed from the legacy hospital file. Previously active facilities are sent to pending review rather than being trusted automatically; the built-in City Hospital demo remains approved.

Render's free web services use ephemeral storage. Hospital accounts and sign-in details saved in the local SQLite database are lost when a free service spins down, restarts, or redeploys. The free service cannot attach a persistent disk; keeping accounts across restarts requires an external database and an app storage integration. Accounts already lost from an ephemeral instance cannot be recovered from this app and must be registered again.

## Configure registration email on Render

User registration sends verification codes through the Gmail API over HTTPS. SMTP is not used. Configure Google OAuth credentials and then add them to the Render service's **Environment** settings:

1. In Google Cloud Console, create or select a project, enable the Gmail API, and configure the OAuth consent screen. Add the Gmail account as a test user if the consent screen is in testing mode.
2. Create an OAuth client ID and configure its redirect URI as `https://developers.google.com/oauthplayground`.
3. Open Google OAuth Playground's settings, enable **Use your own OAuth credentials**, and enter the OAuth client ID and secret.
4. Authorize the scope `https://www.googleapis.com/auth/gmail.send` with the Gmail account that will send verification mail, exchange the authorization code, and copy the refresh token.
5. In Render → `roadrescue` → **Environment**, set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` to the OAuth values. `GMAIL_USER` is configured as `malladiblessy@gmail.com`; it must match the Google account used for authorization. Save and deploy.

Keep the OAuth client secret and refresh token private; never commit them to GitHub. Email requests time out after 10 seconds if Google's API cannot be reached.

Hospital registration geocodes the submitted address into latitude and longitude. It uses Google Geocoding when `GOOGLE_MAPS_API_KEY` is set and falls back to OpenStreetMap Nominatim. When only the locality can be found (rather than the exact building), registration asks the user to confirm the hospital entrance on the map before saving. If address lookup cannot find the location, use **Choose hospital location on map** to place the pin manually. The address form also accepts a Google Maps link containing coordinates. Address geocoding and map tiles therefore need an internet connection.

## Register and approve hospitals

Hospitals can register from the Hospital Login page with their facility name, email, password, and address. New registrations are stored with `status: "approved"` and can sign in and appear in nearby searches immediately after the address is confirmed. Use this automatic approval only when the operator has independently verified each facility before submitting its registration. Existing accounts awaiting review still require an administrator to approve them.

In another PowerShell window, set the same administrator token:

```powershell
$env:HOSPITAL_ADMIN_TOKEN = 'paste the private token from the server window'
$headers = @{ Authorization = "Bearer $env:HOSPITAL_ADMIN_TOKEN" }

Invoke-RestMethod `
  -Uri 'http://127.0.0.1:8000/api/admin/hospitals?status=pending' `
  -Headers $headers
```

After verifying the facility, approve it by ID:

```powershell
$hospitalId = 'hospital-id-from-the-list'
Invoke-RestMethod `
  -Method Patch `
  -Uri "http://127.0.0.1:8000/api/hospitals/$hospitalId" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body '{"status":"approved"}'
```

To keep a record but prevent sign-in, dispatch, and nearby search, set its status to `pending` or `rejected`:

```powershell
Invoke-RestMethod `
  -Method Patch `
  -Uri "http://127.0.0.1:8000/api/hospitals/$hospitalId" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body '{"status":"rejected"}'
```

Administrator endpoints require the `HOSPITAL_ADMIN_TOKEN` bearer token. Never publish or commit the token.

## Hospital login and dispatch

Hospital passwords are stored as salted scrypt hashes. Successful approved-hospital sign-in returns a short-lived bearer token; dashboard and dispatch endpoints require that token. User sign-in also returns a short-lived bearer token, and an emergency request cannot be submitted or tracked without that user session. Every registered hospital receives the same three preconfigured vans, ready to assign without driver setup. Hospital sessions can view and assign only their own vehicles. Starting the server clears previous requests and resets assigned vans to ready; active user and hospital sessions are also cleared, so users and hospitals must sign in again.

User location permission is requested when submitting an emergency alert. The user's coordinates and the request are persisted, and approved hospitals within 20 km can see it. The hospital dashboard, nearby map markers, and user status refresh every five seconds. The first hospital to accept changes the status to `accepted`; assigning an available shared ambulance changes it to `dispatched`.

The hospital dashboard heading shows the name provided during registration. Its **Return to response** button takes the hospital operator back to the user's emergency response dashboard when a user request exists.

## Demo hospital

For local testing, the seeded City Hospital account is `demo@hospital.com` with password `demo123`. Replace or remove this demo account before exposing the app to real users.

The built-in session store is in memory and the app is intended for local development. A public deployment also needs HTTPS, durable session management, production-grade administrator accounts, and operational review of facilities before enabling dispatch.
