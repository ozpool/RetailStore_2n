/**
 * Generates a VAPID keypair for Web Push.
 *
 *   npm run push:keys
 *
 * Plain JavaScript rather than TypeScript, unlike everything else in this
 * directory: it runs before a developer has a working setup, and asking them to
 * have tsx resolving correctly in order to produce the key their setup needs is
 * a circle worth not drawing.
 *
 * ROTATING THESE INVALIDATES EVERY EXISTING SUBSCRIPTION. The public half is
 * baked into each browser's subscription at the moment it is created, so a new
 * keypair silently orphans every device already registered — they stay in the
 * database and every send to them fails. Generate once per environment and keep
 * it, or plan to have everyone re-subscribe.
 *
 * The private key is a secret. The public one is not: it is handed to every
 * browser that subscribes, and a subscription made with it is useless to anyone
 * without the private half.
 */
const webpush = require("web-push");

const keys = webpush.generateVAPIDKeys();

console.log("");
console.log("Add these to backend/.env — the private key is a secret:");
console.log("");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
console.log("");
console.log("Without these, nobody can subscribe and push is reported");
console.log("as unconfigured at startup. Nothing else breaks.");
console.log("");
