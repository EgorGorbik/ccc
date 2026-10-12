declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    RESEND_API_KEY?: string;
    MAIL_FROM?: string;
    BUCKET?: R2Bucket;
    SHOTS?: R2Bucket;
  }
}
