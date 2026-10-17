// Built-in catalog: npm packages and HTTP hosts → external systems.
// Each entry: [regex, system name | (match) => name, kind]. Project config entries are checked first.
// Kinds drive the read-out: database/cache/observability are "core infrastructure" (hidden by default in flows);
// everything else is treated as a side-effecting or user-visible dependency unless review.json says otherwise.

export const PACKAGES = [
  // databases and ORMs (Prisma is handled separately: its provider comes from schema.prisma)
  [/^(pg|pg-pool|postgres|slonik|@neondatabase\/serverless|@vercel\/postgres)$/, 'PostgreSQL', 'database'],
  [/^(mysql2?|@planetscale\/database)$/, 'MySQL', 'database'],
  [/^(better-sqlite3|sqlite3|@libsql\/client)$/, 'SQLite', 'database'],
  [/^(mongodb|mongoose)$/, 'MongoDB', 'database'],
  [/^(typeorm|sequelize|knex|kysely|drizzle-orm|@mikro-orm\/.+|objection)$/, null, 'database'], // name = config.database or "Database"
  [/^@aws-sdk\/(client-dynamodb|lib-dynamodb)$/, 'AWS DynamoDB', 'database'],
  [/^@google-cloud\/firestore$|^firebase-admin\/firestore$/, 'Firestore', 'database'],
  [/^@azure\/cosmos$/, 'Azure Cosmos DB', 'database'],
  [/^(@elastic\/elasticsearch|elasticsearch|@opensearch-project\/opensearch)$/, 'Elasticsearch', 'search'],
  [/^(algoliasearch)$/, 'Algolia', 'search'],
  [/^(meilisearch)$/, 'Meilisearch', 'search'],
  // caches and queues
  [/^(ioredis|redis|@redis\/client|@upstash\/redis)$/, 'Redis', 'cache'],
  [/^(memcached|memjs)$/, 'Memcached', 'cache'],
  [/^(bullmq|bull|bee-queue)$/, 'Redis (job queue)', 'queue'],
  [/^kafkajs$/, 'Kafka', 'queue'],
  [/^(amqplib|amqp-connection-manager)$/, 'RabbitMQ', 'queue'],
  [/^(nats|@nats-io\/.+)$/, 'NATS', 'queue'],
  [/^@aws-sdk\/client-sqs$/, 'AWS SQS', 'queue'],
  [/^@aws-sdk\/client-sns$/, 'AWS SNS', 'notifications'],
  [/^@aws-sdk\/client-eventbridge$/, 'AWS EventBridge', 'queue'],
  [/^@aws-sdk\/client-kinesis$/, 'AWS Kinesis', 'queue'],
  [/^@google-cloud\/pubsub$/, 'Google Pub/Sub', 'queue'],
  [/^@azure\/service-bus$/, 'Azure Service Bus', 'queue'],
  // storage and compute
  [/^@aws-sdk\/(client-s3|s3-request-presigner|lib-storage)$/, 'AWS S3', 'storage'],
  [/^@aws-sdk\/client-lambda$/, 'AWS Lambda', 'compute'],
  [/^@aws-sdk\/client-(ses|sesv2)$/, 'AWS SES (email)', 'email'],
  [/^@aws-sdk\/client-secrets-manager$/, 'AWS Secrets Manager', 'secrets'],
  [/^@aws-sdk\/client-(.+)$/, (m) => `AWS ${m[1].replace(/-/g, ' ').toUpperCase()}`, 'cloud'],
  [/^@google-cloud\/storage$/, 'Google Cloud Storage', 'storage'],
  [/^@azure\/storage-blob$/, 'Azure Blob Storage', 'storage'],
  [/^(cloudinary)$/, 'Cloudinary', 'storage'],
  // payments
  [/^stripe$/, 'Stripe', 'payments'],
  [/^(braintree)$/, 'Braintree', 'payments'],
  [/^(authorizenet)$/, 'Authorize.net', 'payments'],
  [/^(square)$/, 'Square', 'payments'],
  [/^(@adyen\/api-library)$/, 'Adyen', 'payments'],
  [/^(@paypal\/.+|paypal-rest-sdk)$/, 'PayPal', 'payments'],
  // messaging
  [/^twilio$/, 'Twilio', 'sms'],
  [/^(@vonage\/server-sdk|nexmo)$/, 'Vonage', 'sms'],
  [/^@sendgrid\/mail$/, 'SendGrid', 'email'],
  [/^(postmark)$/, 'Postmark', 'email'],
  [/^(nodemailer)$/, 'SMTP email', 'email'],
  [/^(mailgun\.js|mailgun-js)$/, 'Mailgun', 'email'],
  [/^(resend)$/, 'Resend', 'email'],
  [/^(@mailchimp\/.+)$/, 'Mailchimp', 'email'],
  [/^web-push$/, 'Web Push', 'notifications'],
  [/^(expo-server-sdk)$/, 'Expo Push', 'notifications'],
  [/^firebase-admin(\/messaging)?$/, 'Firebase', 'notifications'],
  [/^(@slack\/web-api|@slack\/bolt)$/, 'Slack API', 'chat'],
  [/^(discord\.js)$/, 'Discord', 'chat'],
  // AI
  [/^openai$/, 'OpenAI', 'ai'],
  [/^@anthropic-ai\/sdk$/, 'Anthropic', 'ai'],
  [/^(rss-parser|feedparser|@extractus\/feed-extractor)$/, 'RSS feeds', 'http-api'],
  [/^(@google\/generative-ai|@google\/genai)$/, 'Google Gemini', 'ai'],
  [/^(cohere-ai)$/, 'Cohere', 'ai'],
  [/^(@pinecone-database\/pinecone)$/, 'Pinecone', 'search'],
  // SaaS APIs
  [/^(@octokit\/.+|octokit)$/, 'GitHub API', 'http-api'],
  [/^(googleapis|@googleapis\/.+)$/, 'Google APIs', 'http-api'],
  [/^(@hubspot\/api-client)$/, 'HubSpot', 'http-api'],
  [/^(jsforce)$/, 'Salesforce', 'http-api'],
  [/^(@shopify\/.+)$/, 'Shopify', 'http-api'],
  [/^(@auth0\/.+|auth0)$/, 'Auth0', 'auth'],
  [/^(@clerk\/.+)$/, 'Clerk', 'auth'],
  [/^(@supabase\/supabase-js)$/, 'Supabase', 'database'],
  // observability
  [/^@sentry\//, 'Sentry', 'observability'],
  [/^(dd-trace|datadog-metrics|hot-shots)$/, 'Datadog', 'observability'],
  [/^(newrelic)$/, 'New Relic', 'observability'],
  [/^(@bugsnag\/.+|rollbar)$/, 'Error tracking', 'observability'],
]

// Generic HTTP clients: the system is resolved from hosts found in the calling file.
export const HTTP_CLIENT_PACKAGES = /^(axios|got|node-fetch|undici|ky|superagent|cross-fetch|isomorphic-fetch|needle|request|ofetch)$/

export const HOSTS = [
  [/googleapis\.com|accounts\.google\.com/, (h) => (/mybusiness/.test(h) ? 'Google Business Profile API' : /places|maps/.test(h) ? 'Google Maps/Places API' : /oauth2|accounts\.google/.test(h) ? 'Google OAuth' : /searchconsole|webmasters/.test(h) ? 'Google Search Console API' : 'Google APIs'), 'http-api'],
  [/(^|\.)stripe\.com$/, 'Stripe', 'payments'],
  [/(^|\.)slack\.com$/, 'Slack API', 'chat'],
  [/(^|\.)github\.com$|api\.github\.com/, 'GitHub API', 'http-api'],
  [/(^|\.)vercel\.com$/, 'Vercel API', 'http-api'],
  [/intuit\.com$/, 'QuickBooks (Intuit) API', 'http-api'],
  [/foursquare\.com$/, 'Foursquare Places API', 'http-api'],
  [/postmarkapp\.com$/, 'Postmark', 'email'],
  [/sendgrid\.(com|net)$/, 'SendGrid', 'email'],
  [/mailgun\.net$/, 'Mailgun', 'email'],
  [/twilio\.com$/, 'Twilio', 'sms'],
  [/deepl\.com$/, 'DeepL Translation API', 'http-api'],
  [/authorize\.net$/, 'Authorize.net', 'payments'],
  [/paypal\.com$/, 'PayPal', 'payments'],
  [/squareup\.com$/, 'Square', 'payments'],
  [/openai\.com$/, 'OpenAI', 'ai'],
  [/anthropic\.com$/, 'Anthropic', 'ai'],
  [/hubapi\.com$/, 'HubSpot', 'http-api'],
  [/shopify\.com$|myshopify\.com$/, 'Shopify', 'http-api'],
  [/amazonaws\.com$/, (h) => `AWS (${h.split('.')[0]})`, 'cloud'],
  [/discord\.com$/, 'Discord', 'chat'],
]
// Hosts that are documentation, examples or schema URLs rather than services the code calls.
export const IGNORED_HOSTS = /(^|\.)(example\.(com|org|net)|localhost|127\.0\.0\.1|w3\.org|schema\.org|json-schema\.org|prisma\.io|pris\.ly|wikipedia\.org|stackoverflow\.com|developers?\.[a-z.]+|docs\.[a-z.]+|support\.[a-z.]+|help\.[a-z.]+|github\.io|apache\.org|mozilla\.org|npmjs\.com|nodejs\.org)$/

export const CORE_KINDS = new Set(['database', 'cache', 'observability'])

export function classifyPackage(pkg, overrides = []) {
  if (!pkg) return null
  for (const o of overrides) if (new RegExp(o.match).test(pkg)) return { name: o.name, kind: o.kind ?? 'http-api' }
  for (const [re, name, kind] of PACKAGES) {
    const m = pkg.match(re)
    if (m) return { name: typeof name === 'function' ? name(m) : name, kind }
  }
  return null
}

export function classifyHost(host, overrides = []) {
  for (const o of overrides) if (new RegExp(o.match).test(host)) return o.ignore ? null : { name: o.name, kind: o.kind ?? 'http-api' }
  if (IGNORED_HOSTS.test(host)) return null
  for (const [re, name, kind] of HOSTS) if (re.test(host)) return { name: typeof name === 'function' ? name(host) : name, kind }
  return { name: host, kind: 'http-api' } // unknown host: keep it, named by its hostname
}
