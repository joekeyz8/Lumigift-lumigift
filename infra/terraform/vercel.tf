# ─── #335: Vercel project, domain and environment variables ──────────────────
#
# The frontend is deployed to Vercel. The project, custom domain and env var
# keys are managed here; secret values live in AWS Secrets Manager and are
# never committed. SSL certificates for the custom domain are issued and
# renewed automatically by Vercel once the domain is attached and DNS points
# at Vercel.

provider "vercel" {
  # Authenticate with the VERCEL_API_TOKEN environment variable.
  team = var.vercel_team_id
}

resource "vercel_project" "frontend" {
  name      = var.vercel_project_name
  framework = "nextjs"

  git_repository = {
    type              = "github"
    repo              = var.vercel_git_repo
    production_branch = "main"
  }
}

resource "vercel_project_domain" "frontend" {
  project_id = vercel_project.frontend.id
  domain     = var.domain_name
}

resource "vercel_project_domain" "frontend_www" {
  project_id           = vercel_project.frontend.id
  domain               = "www.${var.domain_name}"
  redirect             = vercel_project_domain.frontend.domain
  redirect_status_code = 308
}

# Secret values: a single JSON secret ({ "KEY": "value", ... }) in Secrets Manager.
data "aws_secretsmanager_secret_version" "vercel_env" {
  secret_id = var.vercel_env_secret_id
}

locals {
  vercel_env_values = jsondecode(data.aws_secretsmanager_secret_version.vercel_env.secret_string)
}

resource "vercel_project_environment_variable" "frontend" {
  for_each = toset(var.vercel_env_keys)

  project_id = vercel_project.frontend.id
  key        = each.value
  value      = local.vercel_env_values[each.value]
  target     = ["production", "preview"]
  sensitive  = true
}

# ─── #562: Network isolation for the database tier ───────────────────────────
#
# The RDS instance accepts inbound Postgres traffic only from the application
# security group. There is no 0.0.0.0/0 ingress rule and the database is not
# publicly accessible.
#
# Emergency DB access: use AWS Systems Manager Session Manager to open a port
# forwarding session through an SSM-managed instance in the application tier
# (no bastion host with a public IP is required), e.g.:
#
#   aws ssm start-session \
#     --target <app-instance-id> \
#     --document-name AWS-StartPortForwardingSessionToRemoteHost \
#     --parameters '{"host":["<rds-endpoint>"],"portNumber":["5432"],"localPortNumber":["5432"]}'
#
# Access is governed by IAM and recorded in Session Manager logs.

resource "aws_security_group" "app" {
  name        = "${var.vercel_project_name}-app"
  description = "Application tier; sole source of database connections"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.vercel_project_name}-app"
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.vercel_project_name}-rds"
  description = "RDS Postgres; inbound only from the application security group"
  vpc_id      = var.vpc_id

  ingress {
    description              = "Postgres from application tier only"
    from_port                = 5432
    to_port                  = 5432
    protocol                 = "tcp"
    source_security_group_id = aws_security_group.app.id
  }

  # No egress restrictions required for the database tier.
  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.vercel_project_name}-rds"
  }
}

# ─── #563: WAF in front of the application ───────────────────────────────────
#
# AWS WAF cannot sit directly in front of Vercel's managed edge, so the web ACL
# is attached to the AWS Application Load Balancer / API Gateway that fronts
# the backend (var.waf_resource_arn). The Vercel deployment is protected by the
# equivalent Vercel Firewall rules; see infra/terraform/README.md for the
# mapping. All rules start in count mode so false positives can be monitored
# for two weeks before switching to blocking mode.

resource "aws_wafv2_web_acl" "app" {
  name        = "${var.vercel_project_name}-waf"
  description = "OWASP protections for the application edge"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-sqli"
    priority = 1

    override_action {
      count {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.vercel_project_name}-waf-sqli"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 2

    override_action {
      count {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.vercel_project_name}-waf-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-bot-control"
    priority = 3

    override_action {
      count {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesBotControlRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.vercel_project_name}-waf-bot-control"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit"
    priority = 4

    action {
      count {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.vercel_project_name}-waf-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.vercel_project_name}-waf"
    sampled_requests_enabled   = true
  }

  tags = {
    Name = "${var.vercel_project_name}-waf"
  }
}

resource "aws_wafv2_web_acl_association" "app" {
  count = var.waf_resource_arn == "" ? 0 : 1

  resource_arn = var.waf_resource_arn
  web_acl_arn  = aws_wafv2_web_acl.app.arn
}

# Alert when blocked requests spike above 1000/min.
resource "aws_cloudwatch_metric_alarm" "waf_blocked_spike" {
  alarm_name          = "${var.vercel_project_name}-waf-blocked-spike"
  alarm_description   = "WAF blocked requests exceeded 1000/min"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 1000
  period              = 60
  statistic           = "Sum"
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  treat_missing_data  = "notBreaching"

  dimensions = {
    WebACL = aws_wafv2_web_acl.app.name
    Region = var.aws_region
    Rule   = "ALL"
  }

  alarm_actions = var.alarm_actions
}
