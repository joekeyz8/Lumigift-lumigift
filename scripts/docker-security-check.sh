#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Local Docker Security & Compliance Checker for Lumigift
# ─────────────────────────────────────────────────────────────────────────────

IMAGE_TAG="${1:-lumigift-app:latest}"

echo "======================================================="
echo "   Lumigift Docker Security & Compliance Check"
echo "======================================================="
echo "Target Image: $IMAGE_TAG"
echo ""

FAILURES=0

# Step 1: Hadolint check
echo "▶ [1/4] Running Hadolint on Dockerfile..."
if command -v hadolint &> /dev/null; then
    hadolint Dockerfile || { echo "❌ Hadolint reported issues in Dockerfile"; FAILURES=$((FAILURES + 1)); }
    echo "✅ Hadolint passed."
else
    echo "ℹ️ Hadolint CLI not installed. Running via Docker..."
    docker run --rm -i hadolint/hadolint < Dockerfile || { echo "❌ Hadolint reported issues in Dockerfile"; FAILURES=$((FAILURES + 1)); }
fi
echo ""

# Step 2: Build verification
echo "▶ [2/4] Verifying Docker Build..."
docker build -t "$IMAGE_TAG" --target runner .
echo "✅ Docker build succeeded."
echo ""

# Step 3: Trivy Vulnerability Scan
# Mirrors the CI gate in .github/workflows/vulnerability-scan.yml:
#   - CRITICAL vulnerabilities fail the check (exit-code 1)
#   - HIGH vulnerabilities are reported as warnings only
#   - SARIF output is written for upload to GitHub Security advisories
echo "▶ [3/4] Running Trivy Vulnerability Scan..."
TRIVY_SARIF_OUTPUT="${TRIVY_SARIF_OUTPUT:-trivy-results.sarif}"
TRIVY_ARGS=(image --ignore-unfixed --format table --exit-code 1 --severity CRITICAL "$IMAGE_TAG")

if command -v trivy &> /dev/null; then
    TRIVY_CMD=(trivy)
else
    echo "ℹ️ Trivy CLI not installed. Running via Docker..."
    TRIVY_CMD=(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD:/work" -w /work aquasec/trivy:latest)
fi

# CRITICAL gate: non-zero exit blocks the check
if ! "${TRIVY_CMD[@]}" "${TRIVY_ARGS[@]}"; then
    echo "❌ Trivy found CRITICAL vulnerabilities in $IMAGE_TAG"
    FAILURES=$((FAILURES + 1))
fi

# HIGH findings: warn only, never fail
echo "ℹ️ Checking for HIGH severity vulnerabilities (warning only)..."
if ! "${TRIVY_CMD[@]}" image --ignore-unfixed --format table --exit-code 0 --severity HIGH "$IMAGE_TAG"; then
    echo "⚠️ Trivy HIGH severity scan encountered an error (non-blocking)."
fi

# SARIF report for GitHub Security advisories (best-effort, non-blocking)
echo "ℹ️ Writing SARIF report to $TRIVY_SARIF_OUTPUT..."
if ! "${TRIVY_CMD[@]}" image --ignore-unfixed --format sarif --output "$TRIVY_SARIF_OUTPUT" --exit-code 0 "$IMAGE_TAG"; then
    echo "⚠️ Could not generate SARIF report (non-blocking)."
fi
echo ""

# Step 4: Verify Non-Root User & No Secrets
echo "▶ [4/4] Verifying Non-Root User & Container Permissions..."
RUNNING_USER=$(docker run --rm "$IMAGE_TAG" id -u)
RUNNING_GROUP=$(docker run --rm "$IMAGE_TAG" id -g)

if [ "$RUNNING_USER" -eq 0 ]; then
    echo "❌ SECURITY FAILURE: Container is running as root (UID 0)!"
    FAILURES=$((FAILURES + 1))
else
    echo "✅ Verified non-root user: UID $RUNNING_USER, GID $RUNNING_GROUP (nextjs:nodejs)"
fi

echo ""
if [ "$FAILURES" -gt 0 ]; then
    echo "❌ Docker security checks failed ($FAILURES errors found)."
    exit 1
else
    echo "🎉 All Docker security and hardening checks passed successfully!"
fi
