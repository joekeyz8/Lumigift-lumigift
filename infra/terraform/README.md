# Lumigift Terraform Infrastructure

This directory contains the Terraform configuration for Lumigift's AWS infrastructure, including the Next.js app (App Runner), PostgreSQL (RDS), Redis (ElastiCache), DNS (Route 53), Secrets Manager, and the remote state backend (S3 + DynamoDB + KMS).

---

## Remote State Setup

Terraform state is stored remotely in S3 with DynamoDB state locking and SSE-KMS encryption at rest.

| Component       | Resource                          | Purpose                              |
|-----------------|-----------------------------------|--------------------------------------|
| S3 bucket       | `lumigift-terraform-state`        | State file storage (versioned)       |
| DynamoDB table  | `lumigift-terraform-locks`        | State locking (prevents concurrent applies) |
| KMS key         | `alias/lumigift-terraform-state`  | State file encryption at rest (SSE-KMS) |

### How it works

1. When `terraform init` runs, Terraform authenticates to S3 and downloads the state file.
2. On `terraform apply`, a lock record is written to DynamoDB. No two processes can hold the lock simultaneously.
3. The state file is encrypted in S3 using the dedicated KMS key — even AWS support cannot read it without the key policy allowing it.

### First-time init

```bash
# Export variables so the backend can resolve them
export TF_VAR_tf_state_kms_key_id="<your-kms-key-id>"
export TF_VAR_db_password="<secure-password>"

# Initialise Terraform with the S3 backend
terraform init

# Create the prod workspace (state is isolated per workspace)
terraform workspace new prod
terraform workspace select prod
```

> **Note:** All sensitive variables should be supplied as environment variables prefixed with `TF_VAR_`. Never store secret values in `terraform.tfvars` or commit them to version control.

### Using workspaces

```bash
# List workspaces
terraform workspace list

# Switch to prod
terraform workspace select prod

# Plan and apply
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

---

## OIDC Authentication (CI/CD)

GitHub Actions authenticates to AWS using **OpenID Connect (OIDC)** — no long-lived AWS access keys are stored in GitHub Secrets. When a workflow runs, GitHub mints a short-lived OIDC token that AWS validates against the registered OIDC provider. AWS then issues temporary credentials scoped to the `github-actions-terraform` IAM role.

### Why OIDC?

- No static credentials to rotate or leak.
- Credentials are scoped to a specific repository and branch/workflow pattern.
- Follows AWS and GitHub security best practices.

### Trust policy

The `aws_iam_role.github_actions_terraform` role uses the following trust condition (managed by Terraform):

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
    },
    "StringLike": {
      "token.actions.githubusercontent.com:sub": "repo:joekeyz8/Lumigift-lumigift:*"
    }
  }
}
```

The `StringLike` condition means only workflows originating from `joekeyz8/Lumigift-lumigift` can assume this role. The `*` wildcard covers all branches and environments; tighten it (e.g. `ref:refs/heads/main`) for production-only applies.

### Bootstrap the OIDC provider once

The OIDC provider and IAM role only need to be created once per AWS account. Use a targeted apply so you do not need backend credentials yet:

```bash
# Use local state for the initial bootstrap (one-time only)
terraform init -backend=false

terraform apply \
  -target=aws_iam_openid_connect_provider.github_actions \
  -target=aws_iam_role.github_actions_terraform \
  -target=aws_iam_role_policy.github_actions_terraform_state
```

After the role exists, add its ARN as `AWS_ROLE_ARN` in your GitHub repository secrets, then all subsequent CI runs will use OIDC.

### GitHub Actions workflow configuration

The CI workflow (`../.github/workflows/terraform.yml`) uses:

```yaml
permissions:
  id-token: write   # required for OIDC
  contents: read
  pull-requests: write

- name: Configure AWS credentials (OIDC)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
    aws-region: us-east-1
```

No `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` secrets are needed.

---

## Variables

| Variable              | Type           | Required | Description                                                  |
|-----------------------|----------------|----------|--------------------------------------------------------------|
| `aws_region`          | `string`       | No       | AWS region (default: `us-east-1`)                            |
| `env`                 | `string`       | No       | Deployment environment — `prod` or `staging` (default: `prod`) |
| `vpc_id`              | `string`       | **Yes**  | VPC ID for all resources                                     |
| `private_subnet_ids`  | `list(string)` | **Yes**  | Private subnet IDs for RDS and ElastiCache                   |
| `db_instance_class`   | `string`       | No       | RDS instance class (default: `db.t4g.micro`)                 |
| `db_password`         | `string`       | **Yes**  | RDS master password — supply as `TF_VAR_db_password`         |
| `redis_node_type`     | `string`       | No       | ElastiCache node type (default: `cache.t4g.micro`)           |
| `app_image`           | `string`       | **Yes**  | ECR image URI for the Next.js app                            |
| `domain_name`         | `string`       | **Yes**  | Root domain in Route 53 (e.g. `lumigift.app`)                |
| `ops_alert_email`     | `string`       | No       | Email for backup failure SNS alerts                          |
| `github_org`          | `string`       | No       | GitHub org that owns the repo (default: `joekeyz8`)          |
| `github_repo`         | `string`       | No       | GitHub repo name (default: `Lumigift-lumigift`)              |
| `tf_state_kms_key_id` | `string`       | **Yes**  | Pre-created KMS key ID for state encryption (bootstrap step) |

All sensitive variables (`db_password`, `tf_state_kms_key_id`) should be supplied via environment variables (`TF_VAR_*`), never in committed files.

---

## First-time Setup

Follow these steps when setting up the infrastructure for the first time in a new AWS account.

### Prerequisites

- AWS CLI configured with an account that has broad IAM and infrastructure permissions.
- [Terraform ≥ 1.6](https://developer.hashicorp.com/terraform/downloads)
- The S3 bucket (`lumigift-terraform-state`) and DynamoDB table (`lumigift-terraform-locks`) must exist before running `terraform init`. Create them manually or via the AWS console/CLI:

```bash
# Create the state bucket with versioning
aws s3api create-bucket \
  --bucket lumigift-terraform-state \
  --region us-east-1

aws s3api put-bucket-versioning \
  --bucket lumigift-terraform-state \
  --versioning-configuration Status=Enabled

# Create the lock table
aws dynamodb create-table \
  --table-name lumigift-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

### Step-by-step

1. **Create the KMS key** for state encryption (one-time bootstrap):

   ```bash
   KMS_KEY_ID=$(aws kms create-key \
     --description "Bootstrap KMS key for Terraform state" \
     --query "KeyMetadata.KeyId" \
     --output text)
   echo "KMS Key ID: $KMS_KEY_ID"

   aws kms create-alias \
     --alias-name alias/lumigift-terraform-state \
     --target-key-id "$KMS_KEY_ID"
   ```

2. **Copy and configure the example vars file**:

   ```bash
   cp terraform.tfvars.example terraform.tfvars
   # Edit terraform.tfvars — fill in tf_state_kms_key_id and other values
   ```

3. **Export sensitive variables**:

   ```bash
   export TF_VAR_tf_state_kms_key_id="$KMS_KEY_ID"
   export TF_VAR_db_password="<secure-random-password>"
   ```

4. **Bootstrap the OIDC provider** (one-time, uses local state):

   ```bash
   terraform init -backend=false
   terraform apply \
     -target=aws_iam_openid_connect_provider.github_actions \
     -target=aws_iam_role.github_actions_terraform \
     -target=aws_iam_role_policy.github_actions_terraform_state
   ```

5. **Add the role ARN to GitHub Secrets**:
   - Go to `https://github.com/joekeyz8/Lumigift-lumigift/settings/secrets/actions`
   - Add secret `AWS_ROLE_ARN` with the ARN from step 4.

6. **Initialise with the remote backend**:

   ```bash
   terraform init
   terraform workspace new prod
   ```

7. **Plan and apply** the full infrastructure:

   ```bash
   terraform plan -var-file=terraform.tfvars
   terraform apply -var-file=terraform.tfvars
   ```

---

## Security Notes

- **State encryption**: The S3 state file is encrypted using a dedicated customer-managed KMS key (`alias/lumigift-terraform-state`) with automatic key rotation enabled.
- **State locking**: DynamoDB prevents concurrent Terraform operations, avoiding state corruption.
- **OIDC only**: CI/CD never receives static AWS credentials. The GitHub OIDC role policy is scoped to the minimum permissions required for remote state access.
- **Sensitive outputs**: The `outputs.tf` file marks sensitive values (e.g. backup runner credentials) with `sensitive = true`.
- **Never commit**: `terraform.tfvars` is gitignored. Secret values must always be injected via environment variables or a secrets manager.

---

## Network Security

### Database access (app tier only)

The RDS security group (`aws_security_group.rds`) does **not** allow inbound access from `0.0.0.0/0`. The only inbound rule permits TCP port `5432` from the application security group (`aws_security_group.app`), so only the App Runner service can reach PostgreSQL.

- RDS is deployed in private subnets with `publicly_accessible = false` — there is no public IP path to the database.
- ElastiCache follows the same pattern: port `6379` is reachable only from the app security group.
- Any new consumer of the database must be attached to the app security group (or a dedicated SG explicitly added to the RDS ingress rule) — do not widen the CIDR range.

### Emergency database access

There is no direct network path from a developer workstation to RDS. For break-glass access use one of:

1. **SSM Session Manager (preferred)** — start a session on an instance in the app tier (or a dedicated bastion) via the SSM agent, then connect to RDS using `psql` from that host. No inbound SSH port is required and all sessions are logged in CloudTrail / Session Manager history.
2. **Bastion host** — if a bastion is provisioned, it lives in a public subnet with a security group that only accepts SSH from approved CIDR ranges, and its egress is limited to the RDS security group on port `5432`. Bastion access should be temporary and removed after use.

Never add `0.0.0.0/0` ingress rules to the RDS security group, even temporarily.

---

## Web Application Firewall (WAF)

An AWS WAF web ACL (`aws_wafv2_web_acl`) is attached in front of the application to mitigate OWASP Top 10 attacks at the edge. The configuration is managed entirely in Terraform.

### Rules

| Rule | Purpose |
|------|---------|
| AWS Managed Rules — SQL injection | Blocks SQLi payloads in query strings, body, and headers |
| AWS Managed Rules — XSS | Blocks cross-site scripting payloads |
| Rate-based rule | Limits requests per IP (rate limiting / abuse protection) |
| AWS Managed Rules — Bot Control / known bad inputs | Filters bad bots and known malicious inputs |

### Rollout: count mode first

All rules are deployed in **count mode** initially so that legitimate traffic is not blocked while baselines are established:

1. Apply the WAF with every rule action set to `count`.
2. Monitor CloudWatch WAF metrics and sampled requests for **two weeks**, reviewing any matches for false positives.
3. Tune rule exclusions/scope-down statements as needed.
4. Only after the two-week observation period, switch the rule actions to `block` and re-apply.

### Alerting

A CloudWatch alarm fires when the number of blocked requests exceeds **1000 per minute**. The alarm publishes to the ops SNS topic (`ops_alert_email`) so the on-call engineer can investigate a potential attack or a misconfigured rule.

---

## Applying Changes

All infrastructure changes follow a staging-first procedure:

1. Run `terraform validate` — this is **required** and must pass before any plan or apply.
2. `terraform workspace select staging` and run `terraform plan -var-file=terraform.tfvars`; review the plan output carefully (especially security group and WAF changes).
3. Apply to staging: `terraform apply -var-file=terraform.tfvars`.
4. Verify behaviour in staging (connectivity, WAF metrics, alarms) before promoting.
5. Switch to the prod workspace and repeat plan → review → apply.

CI enforces `terraform fmt -check` and `terraform validate` on every pull request; do not merge a plan that has not been validated.
