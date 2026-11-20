import * as Sentry from "@sentry/nextjs";

const environment =
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
  (process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV);

const release =
  process.env.NEXT_PUBLIC_SENTRY_RELEASE ??
  process.env.SENTRY_RELEASE ??
  undefined;

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment,
  release,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  // Anonymize user context — no PII
  beforeSend(event) {
    if (event.user) {
      delete event.user.email;
      delete event.user.ip_address;
    }
    return event;
  },
});