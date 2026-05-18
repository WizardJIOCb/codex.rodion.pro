# OAuth setup

The app supports password login plus social login/registration through Google and VK ID.

## Environment variables

Set these in `.env` on the server:

```env
PUBLIC_BASE_URL=https://codex.rodion.pro

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

VK_CLIENT_ID=
VK_CLIENT_SECRET=
```

`PUBLIC_BASE_URL` must be the exact public HTTPS origin users open in the browser. It is used to build callback URLs behind Caddy/Nginx.

## Callback URLs

Register these redirect/callback URLs in provider dashboards:

```text
https://codex.rodion.pro/api/oauth/google/callback
https://codex.rodion.pro/api/oauth/vk/callback
```

For a different domain, replace only `https://codex.rodion.pro`.

## Where to get credentials

Google:

- Open Google Cloud Console -> APIs & Services -> Credentials.
- Create an OAuth client for a web application.
- Add the Google callback URL above to Authorized redirect URIs.
- Copy Client ID and Client secret to `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

VK ID:

- Open the VK ID developer/business cabinet at `id.vk.ru`.
- Create a web app for the domain.
- Add the VK callback URL above as a trusted redirect URL.
- Enable the scopes for personal info and email.
- Copy the app/client ID and secret to `VK_CLIENT_ID` and `VK_CLIENT_SECRET`.

## Behavior

- If a social login email already exists locally, the provider is linked to that user.
- If the email is new, a user is created. The first user in the database becomes `admin`; later users become `user`.
- Logged-in users can connect/reconnect providers from Profile -> OAuth connections.
- Provider tokens are used only during login and are not stored.
