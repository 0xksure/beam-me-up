/**
 * scaffold_auth (M8) - generate a ready-to-apply Google sign-in scaffold.
 *
 * PURE (no filesystem/network), like the other generation tools: it returns the
 * files (with contents), env vars, OAuth redirect URIs, and ordered steps; the
 * host AI writes the files with its OWN tools after the user confirms.
 *
 * Used when preflight_scan's `auth.loginImplemented` is false (and the app should
 * have sign-in): the host AI OFFERS to add login, and on a yes calls this with
 * `{ provider: "google", framework }`. The scaffold is tailored to the framework:
 *   - "nextjs"  : Auth.js (NextAuth v5) Google provider
 *   - "express" : passport-google-oauth20 + express-session
 *   - "generic" : framework-agnostic setup steps
 *
 * `mode: "internal"` adds an email-domain allowlist gate to the sign-in callback.
 */
import type {
  ScaffoldAuthInput,
  ScaffoldAuthOutput,
  ScaffoldEnvVar,
  ScaffoldFile,
  ScaffoldAuthFramework,
} from "@beam-me-up/core";

export function scaffoldAuth(input: ScaffoldAuthInput): ScaffoldAuthOutput {
  const provider = input.provider ?? "google";
  const framework = resolveFramework(input.framework, input.stack);
  const mode = input.mode ?? "product";
  const base = normalizeUrl(input.appUrl);
  const localBase = "http://localhost:3000";
  const allowedDomain =
    mode === "internal" ? sanitizeDomain(input.allowedDomain) : undefined;

  const ctx = { provider, framework, mode, base, localBase, allowedDomain };
  if (framework === "nextjs") return nextjsGoogle(ctx);
  if (framework === "express") return expressGoogle(ctx);
  return genericGoogle(ctx);
}

type Ctx = {
  provider: string;
  framework: ScaffoldAuthFramework;
  mode: "product" | "internal";
  base: string;
  localBase: string;
  allowedDomain?: string;
};

/* ------------------------------------------------------------------ */
/* framework resolution + url helpers                                  */
/* ------------------------------------------------------------------ */

function resolveFramework(
  explicit: ScaffoldAuthFramework | undefined,
  stack: string | undefined,
): ScaffoldAuthFramework {
  if (explicit) return explicit;
  const s = (stack ?? "").toLowerCase();
  if (/next/.test(s)) return "nextjs";
  if (/express|node|connect/.test(s)) return "express";
  return "generic";
}

/**
 * Validate + normalize the app URL. Only a well-formed http(s) URL is accepted
 * (so it can't inject quotes/newlines into the generated code or redirect URIs);
 * anything else falls back to a clearly-fake placeholder.
 */
function normalizeUrl(url: string | undefined): string {
  const u = (url ?? "").trim();
  if (u.length === 0) return "<your-app-url>";
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "<your-app-url>";
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "<your-app-url>";
  }
}

/**
 * Validate an email domain (internal mode). Only a hostname-shaped value is
 * accepted; anything else falls back to a placeholder so a crafted value can't
 * break out of the generated string literal or neutralize the allowlist gate.
 */
function sanitizeDomain(domain: string | undefined): string {
  const d = (domain ?? "").trim();
  return /^[a-z0-9.-]+$/i.test(d) ? d : "yourco.com";
}

/** Shared, framework-independent warnings + opening steps. */
function commonWarnings(ctx: Ctx): string[] {
  const w = [
    "Register the EXACT redirect URI(s) below in the Google Cloud console (APIs & Services -> Credentials -> your OAuth client). A trailing slash or http/https mismatch is the usual cause of `redirect_uri_mismatch`.",
    "Generate a strong session/JWT secret (e.g. `openssl rand -base64 33`) and load it from an env var — never commit it.",
    "After deploying, set the same env vars on the host (set_env_vars) and add the PRODUCTION redirect URI to the Google OAuth client.",
  ];
  if (ctx.allowedDomain) {
    w.push(
      `Internal mode: sign-in is gated to @${ctx.allowedDomain}. Verify a Google account outside that domain is rejected.`,
    );
  }
  return w;
}

function googleConsoleSteps(ctx: Ctx, redirectUris: string[]): string[] {
  return [
    "Create a Google OAuth client: Google Cloud Console -> APIs & Services -> Credentials -> Create credentials -> OAuth client ID -> Application type: Web application.",
    `Add these Authorized redirect URIs: ${redirectUris.join("  ,  ")}`,
    "Copy the Client ID and Client secret from the dialog into the env vars listed below.",
  ];
}

/* ------------------------------------------------------------------ */
/* Next.js (Auth.js / NextAuth v5)                                     */
/* ------------------------------------------------------------------ */

function nextjsGoogle(ctx: Ctx): ScaffoldAuthOutput {
  const redirectUris = [
    `${ctx.base}/api/auth/callback/google`,
    `${ctx.localBase}/api/auth/callback/google`,
  ];

  const signInCallback = ctx.allowedDomain
    ? `
  callbacks: {
    // Internal mode: only allow verified Google accounts on the company domain.
    async signIn({ profile }) {
      const allowedDomain = ${JSON.stringify(ctx.allowedDomain)};
      if (profile?.email_verified === false) return false;
      return Boolean(profile?.email) && profile.email.endsWith("@" + allowedDomain);
    },
  },`
    : "";

  const authTs = `import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// Auth.js v5. Google reads AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET from the env
// automatically; AUTH_SECRET signs the session. See https://authjs.dev.
export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],${signInCallback}
});
`;

  const routeTs = `// Re-export the Auth.js route handlers. Assumes the "@/*" path alias
// (the create-next-app default). If you don't use it, import from a relative
// path to auth.ts instead.
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
`;

  const middlewareTs = `// Protect routes by running Auth.js as middleware. Adjust the matcher to the
// routes that require sign-in. Remove this file if you gate access in-page.
export { auth as middleware } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
`;

  const files: ScaffoldFile[] = [
    {
      path: "auth.ts",
      contents: authTs,
      action: "create",
      note: "Auth.js config. Place at the project root (or src/) so `@/auth` resolves.",
    },
    {
      path: "app/api/auth/[...nextauth]/route.ts",
      contents: routeTs,
      action: "create",
      note: "App Router catch-all that serves /api/auth/*.",
    },
    {
      path: "middleware.ts",
      contents: middlewareTs,
      action: "create",
      note: "Optional: gate routes. Tune the matcher; delete if you protect pages individually.",
    },
  ];

  const envVars: ScaffoldEnvVar[] = [
    {
      key: "AUTH_SECRET",
      example: "<run: openssl rand -base64 33>",
      secret: true,
      note: "Signs the session. Required.",
    },
    {
      key: "AUTH_GOOGLE_ID",
      example: "<client-id>.apps.googleusercontent.com",
      secret: false,
    },
    { key: "AUTH_GOOGLE_SECRET", example: "GOCSPX-<client-secret>", secret: true },
    {
      key: "AUTH_URL",
      example: `${ctx.base}`,
      secret: false,
      note: "Set to your production URL on the host (Auth.js infers it locally).",
    },
  ];

  const steps = [
    ...googleConsoleSteps(ctx, redirectUris),
    "Install the dependency: `npm install next-auth@beta` (Auth.js v5).",
    "Create the files below (auth.ts, the [...nextauth] route, and optionally middleware.ts).",
    "Add a Sign in / Sign out control: call `signIn(\"google\")` / `signOut()` from a client component, or use `<form action={async () => { \"use server\"; await signIn(\"google\"); }}>`.",
    "Run `npm run dev`, sign in with Google, then deploy and add the production redirect URI + env vars.",
  ];

  return {
    provider: ctx.provider,
    framework: "nextjs",
    dependencies: ["next-auth@beta"],
    envVars,
    redirectUris,
    files,
    steps,
    warnings: [
      ...commonWarnings(ctx),
      "auth.ts uses the `@/*` path alias. If your tsconfig has no `@/*` paths entry, add one or switch the imports in the route/middleware to a relative path.",
    ],
    summary: `Google sign-in for Next.js via Auth.js v5: an auth.ts config, the /api/auth/[...nextauth] route${ctx.allowedDomain ? `, a domain allowlist (@${ctx.allowedDomain})` : ""}, and optional route-protecting middleware. Register the redirect URI, set AUTH_SECRET + AUTH_GOOGLE_ID/SECRET, then sign in.`,
  };
}

/* ------------------------------------------------------------------ */
/* Express (passport-google-oauth20 + express-session)                 */
/* ------------------------------------------------------------------ */

function expressGoogle(ctx: Ctx): ScaffoldAuthOutput {
  const redirectUris = [
    `${ctx.base}/auth/google/callback`,
    `${ctx.localBase}/auth/google/callback`,
  ];

  const domainGate = ctx.allowedDomain
    ? `
      // Internal mode: only allow accounts on the company domain.
      const allowedDomain = ${JSON.stringify(ctx.allowedDomain)};
      if (!email || !email.endsWith("@" + allowedDomain)) {
        return done(null, false);
      }`
    : "";

  const authJs = `// Google OAuth via Passport. Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// (and an optional GOOGLE_CALLBACK_URL) from the environment.
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:
        process.env.GOOGLE_CALLBACK_URL || ${JSON.stringify(ctx.base + "/auth/google/callback")},
    },
    function (accessToken, refreshToken, profile, done) {
      const email =
        profile.emails && profile.emails[0] && profile.emails[0].value;${domainGate}
      const user = { id: profile.id, email: email, name: profile.displayName };
      return done(null, user);
    },
  ),
);

passport.serializeUser(function (user, done) {
  done(null, user);
});
passport.deserializeUser(function (user, done) {
  done(null, user);
});

module.exports = passport;
`;

  const wiringSnippet = `// --- Google sign-in wiring (merge into your Express app, after \`const app = express()\`) ---
const session = require("express-session");
const passport = require("./auth");

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  }),
);
app.use(passport.initialize());
app.use(passport.session());

// Start the OAuth dance and handle the callback.
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] }),
);
app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login" }),
  function (req, res) {
    res.redirect("/");
  },
);
app.get("/auth/logout", function (req, res, next) {
  req.logout(function (err) {
    if (err) return next(err);
    res.redirect("/");
  });
});

// Use this to protect routes: app.post("/api/thing", requireAuth, handler)
function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: "login required" });
}
module.exports.requireAuth = requireAuth;
`;

  const files: ScaffoldFile[] = [
    {
      path: "auth.js",
      contents: authJs,
      action: "create",
      note: "Passport Google strategy. Put it next to your server entry file.",
    },
    {
      path: "auth-wiring.snippet.js",
      contents: wiringSnippet,
      action: "merge",
      note: "Not a standalone file — merge these blocks into your Express server (app.js / server.js / index.js) and apply `requireAuth` to the routes that need sign-in.",
    },
  ];

  const envVars: ScaffoldEnvVar[] = [
    {
      key: "GOOGLE_CLIENT_ID",
      example: "<client-id>.apps.googleusercontent.com",
      secret: false,
    },
    { key: "GOOGLE_CLIENT_SECRET", example: "GOCSPX-<client-secret>", secret: true },
    {
      key: "SESSION_SECRET",
      example: "<run: openssl rand -base64 33>",
      secret: true,
      note: "Signs the session cookie. Required.",
    },
    {
      key: "GOOGLE_CALLBACK_URL",
      example: `${ctx.base}/auth/google/callback`,
      secret: false,
      note: "Optional override; defaults to the same value in code.",
    },
  ];

  const steps = [
    ...googleConsoleSteps(ctx, redirectUris),
    "Install the dependencies: `npm install passport passport-google-oauth20 express-session`.",
    "Create auth.js and merge auth-wiring.snippet.js into your Express server.",
    "Protect your mutating routes by adding the `requireAuth` middleware.",
    "Run the server, visit /auth/google to sign in, then deploy and add the production redirect URI + env vars.",
  ];

  return {
    provider: ctx.provider,
    framework: "express",
    dependencies: ["passport", "passport-google-oauth20", "express-session"],
    envVars,
    redirectUris,
    files,
    steps,
    warnings: [
      ...commonWarnings(ctx),
      "express-session's default MemoryStore is single-process and resets on restart — use a persistent store (connect-redis / connect-pg-simple) for any multi-instance or production deploy.",
    ],
    summary: `Google sign-in for Express via Passport: an auth.js strategy + a wiring snippet (session, /auth/google, /auth/google/callback, /auth/logout, and a requireAuth guard)${ctx.allowedDomain ? `, gated to @${ctx.allowedDomain}` : ""}. Register the redirect URI, set the client id/secret + SESSION_SECRET, then sign in.`,
  };
}

/* ------------------------------------------------------------------ */
/* generic (framework-agnostic steps)                                  */
/* ------------------------------------------------------------------ */

function genericGoogle(ctx: Ctx): ScaffoldAuthOutput {
  const redirectUris = [
    `${ctx.base}/auth/google/callback`,
    `${ctx.localBase}/auth/google/callback`,
  ];

  const envVars: ScaffoldEnvVar[] = [
    {
      key: "GOOGLE_CLIENT_ID",
      example: "<client-id>.apps.googleusercontent.com",
      secret: false,
    },
    { key: "GOOGLE_CLIENT_SECRET", example: "GOCSPX-<client-secret>", secret: true },
    {
      key: "SESSION_SECRET",
      example: "<run: openssl rand -base64 33>",
      secret: true,
      note: "Signs the session/JWT. Required.",
    },
  ];

  const notes = `# Google sign-in — manual setup (no framework-specific scaffold)

Your stack wasn't recognized as Next.js or Express, so here is the
provider-agnostic OAuth 2.0 / OpenID Connect flow to implement with whatever
auth library fits your framework:

1. Pick an OIDC/OAuth client library for your language/framework (e.g.
   Authlib for Python, Spring Security OAuth for Java, Devise+omniauth-google
   for Rails, goth for Go).
2. Configure the Google provider with GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
3. Add two routes: one that redirects to Google's consent screen with scopes
   "openid email profile", and a callback route at the redirect URI below that
   exchanges the code for tokens and creates a session.
4. Store the signed-in user in a secure, httpOnly, sameSite session cookie (or a
   signed JWT). Protect your mutating routes behind a "require auth" check.${
     ctx.allowedDomain
       ? `\n5. Internal mode: in the callback, reject any account whose email does not end with "@${ctx.allowedDomain}".`
       : ""
   }
`;

  const files: ScaffoldFile[] = [
    {
      path: "GOOGLE_AUTH_SETUP.md",
      contents: notes,
      action: "create",
      note: "Reference notes — adapt to your framework's auth library.",
    },
  ];

  const steps = [
    ...googleConsoleSteps(ctx, redirectUris),
    "Choose an OIDC/OAuth client library for your framework and install it.",
    "Implement a login route (redirect to Google) and a callback route at the redirect URI.",
    "Create a secure session (httpOnly + sameSite cookie or signed JWT) and a require-auth guard for protected routes.",
    "Set the env vars, test sign-in locally, then deploy and add the production redirect URI.",
  ];

  return {
    provider: ctx.provider,
    framework: "generic",
    dependencies: [],
    envVars,
    redirectUris,
    files,
    steps,
    warnings: [
      ...commonWarnings(ctx),
      "No framework-specific code was generated — follow GOOGLE_AUTH_SETUP.md with your framework's auth library.",
    ],
    summary: `Framework-agnostic Google sign-in steps (stack not recognized as Next.js/Express): the OAuth client setup, redirect URIs, env vars${ctx.allowedDomain ? `, and a @${ctx.allowedDomain} allowlist note` : ""}, plus a GOOGLE_AUTH_SETUP.md to adapt to your framework.`,
  };
}
