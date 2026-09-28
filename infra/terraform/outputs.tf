output "app_url" {
  description = "App Runner service URL"
  value       = aws_apprunner_service.app.service_url
}

output "db_endpoint" {
  description = "RDS endpoint"
  value       = aws_db_instance.postgres.endpoint
  sensitive   = true
}

output "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  value       = aws_elasticache_cluster.redis.cache_nodes[0].address
  sensitive   = true
}

output "app_runner_instance_role_arn" {
  description = "IAM Role ARN assumed by App Runner instance for secrets access"
  value       = aws_iam_role.app_runner_instance_role.arn
}

output "secret_arns" {
  description = "Map of AWS Secrets Manager secret ARNs for production"
  value = {
    DATABASE_URL              = aws_secretsmanager_secret.db_url.arn
    REDIS_URL                 = aws_secretsmanager_secret.redis_url.arn
    NEXTAUTH_SECRET           = aws_secretsmanager_secret.nextauth_secret.arn
    NEXTAUTH_SECRET_PREVIOUS  = aws_secretsmanager_secret.nextauth_secret_previous.arn
    CSRF_SECRET               = aws_secretsmanager_secret.csrf_secret.arn
    CRON_SECRET               = aws_secretsmanager_secret.cron_secret.arn
    STELLAR_SERVER_SECRET_KEY = aws_secretsmanager_secret.stellar_server_secret_key.arn
    STELLAR_ESCROW_CONTRACT_ID= aws_secretsmanager_secret.stellar_escrow_contract_id.arn
    PAYSTACK_SECRET_KEY       = aws_secretsmanager_secret.paystack_secret_key.arn
    STRIPE_SECRET_KEY         = aws_secretsmanager_secret.stripe_secret_key.arn
    STRIPE_WEBHOOK_SECRET     = aws_secretsmanager_secret.stripe_webhook_secret.arn
    TERMII_API_KEY            = aws_secretsmanager_secret.termii_api_key.arn
    CLOUDINARY_API_SECRET     = aws_secretsmanager_secret.cloudinary_api_secret.arn
    CLOUDINARY_API_KEY        = aws_secretsmanager_secret.cloudinary_api_key.arn
  }
}

