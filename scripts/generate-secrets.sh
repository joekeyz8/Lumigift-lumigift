#!/bin/bash

# Script to generate cryptographically secure secrets for Lumigift
# Usage: ./scripts/generate-secrets.sh

set -e

echo "🔐 Generating cryptographic secrets for Lumigift..."
echo ""

# Generate NEXTAUTH_SECRET
NEXTAUTH_SECRET=$(openssl rand -base64 32)
echo "NEXTAUTH_SECRET=$NEXTAUTH_SECRET"
echo ""

# Generate CSRF_SECRET
CSRF_SECRET=$(openssl rand -base64 32)
echo "CSRF_SECRET=$CSRF_SECRET"
echo ""

# Generate CRON_SECRET
CRON_SECRET=$(openssl rand -base64 32)
echo "CRON_SECRET=$CRON_SECRET"
echo ""

echo "✅ High-entropy secrets generated successfully!"
echo ""
echo "📝 For local development: copy these to .env.local"
echo "☁️  For AWS Secrets Manager (production):"
echo "   aws secretsmanager put-secret-value --secret-id lumigift/prod/NEXTAUTH_SECRET --secret-string \"$NEXTAUTH_SECRET\""
echo "   aws secretsmanager put-secret-value --secret-id lumigift/prod/CSRF_SECRET --secret-string \"$CSRF_SECRET\""
echo "   aws secretsmanager put-secret-value --secret-id lumigift/prod/CRON_SECRET --secret-string \"$CRON_SECRET\""
echo ""

# ---------------------------------------------------------------------------
# RDS database credentials (issue #556)
#
# The application fetches DB credentials from AWS Secrets Manager at runtime
# (via the Secrets Manager SDK) instead of a static env var. The secret must
# use the standard RDS rotation JSON shape so the rotation Lambda can update
# it in place:
#
#   {
#     "username": "...",
#     "password": "...",
#     "engine":   "postgres",
#     "host":     "...",
#     "port":     5432,
#     "dbname":   "..."
#   }
#
# Rotation is performed automatically every 90 days by the rotation Lambda
# attached below. See docs/ops/key-rotation.md for the rotation drill.
# ---------------------------------------------------------------------------

echo "🗄️  RDS database credentials (AWS Secrets Manager, issue #556)"
echo ""
echo "   The application reads DB credentials from Secrets Manager at runtime."
echo "   Create the secret with the standard RDS rotation JSON shape:"
echo ""
echo "   aws secretsmanager create-secret \\"
echo "     --name lumigift/prod/rds \\"
echo "     --description \"Lumigift RDS credentials (auto-rotated every 90 days)\" \\"
echo "     --secret-string '{\"username\":\"lumigift\",\"password\":\"<DB_PASSWORD>\",\"engine\":\"postgres\",\"host\":\"<RDS_ENDPOINT>\",\"port\":5432,\"dbname\":\"lumigift\"}'"
echo ""
echo "   Attach the rotation Lambda (runs every 90 days):"
echo ""
echo "   aws secretsmanager rotate-secret \\"
echo "     --secret-id lumigift/prod/rds \\"
echo "     --rotation-lambda-arn arn:aws:lambda:<REGION>:<ACCOUNT_ID>:function:lumigift-rds-rotation \\"
echo "     --rotation-rules AutomaticallyAfterDays=90"
echo ""
echo "   Verify the rotation configuration:"
echo ""
echo "   aws secretsmanager describe-secret --secret-id lumigift/prod/rds"
echo ""
echo "   Run a manual rotation drill (see docs/ops/key-rotation.md):"
echo ""
echo "   aws secretsmanager rotate-secret --secret-id lumigift/prod/rds"
echo ""