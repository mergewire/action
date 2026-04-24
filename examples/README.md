# MergeWire Examples

This directory contains example configurations and workflows for the MergeWire GitHub Action.

## Files

| File             | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `minimal.yml`    | Minimal copy-paste starter workflow (no cloud credentials) |
| `workflow.yml`   | Full example with AWS OIDC credentials and output logging  |
| `aws-oidc.yml`   | AWS OIDC authentication with no static credentials         |
| `.mergewire.yml` | Routing rules configuration for supported rule types       |
| `TAXONOMY.md`    | Complete reference for services and categories             |

Advanced examples:

| File                    | Description                                  |
| ----------------------- | -------------------------------------------- |
| `multi-root.yml`        | Matrix strategy for explicit Terraform roots |
| `webhooks.yml`          | Rule-based generic webhook routing config    |
| `webhooks-workflow.yml` | Workflow wiring for generic webhook delivery |

## Quick Start

1. **Copy the example workflow** to `.github/workflows/mergewire.yml`:

   ```bash
   cp workflow.yml /path/to/your/repo/.github/workflows/mergewire.yml
   ```

2. **Create your routing rules** at the repository root:

   ```bash
   cp .mergewire.yml /path/to/your/repo/.mergewire.yml
   ```

3. **Customize the rules** for your organization (see sections below)

4. **Add secrets and variables** to your GitHub repository:
   - Secret `MERGEWIRE_API_KEY` — your workspace API key from the MergeWire dashboard
   - Variable `MERGEWIRE_API_URL` — your MergeWire API endpoint (`https://api.mergewire.app`)
   - Secret `AWS_ROLE_ARN` — (optional) IAM role ARN for Terraform plan generation via OIDC

## Rule Types

### Basic Rules

Match resources by type, action, location, or module:

```yaml
- id: production-destructive
  when:
    actions: [delete, replace]
    filePaths: ["environments/prod/**/*"]
  severity: high
```

### Volume Rules (Blast Radius)

Limit changes by count or percentage:

```yaml
- id: delete-limit
  when:
    actions: [delete]
    changeCount:
      deleteGte: 5 # Max 5 deletes per PR
  severity: high
```

```yaml
- id: blast-radius
  when:
    changePercentage:
      totalGte: 50 # Max 50% of state
  severity: critical
```

### Service Rules

Match by cloud provider service:

```yaml
- id: aws-iam-changes
  when:
    services: ["aws:iam"] # Matches aws_iam_role, aws_iam_policy, etc.
  severity: high
```

### Category Rules (Cross-Cloud)

Match by high-level category across all clouds:

```yaml
- id: database-changes
  when:
    categories: ["database"] # Matches RDS, Cloud SQL, CosmosDB, etc.
  severity: medium
```

## Common Patterns

### Production Protection

```yaml
rules:
  # Limit deletions in production
  - id: prod-delete-limit
    when:
      actions: [delete]
      filePaths: ["environments/prod/**/*"]
      changeCount:
        deleteGte: 3
    severity: critical

  # Require review for high blast radius
  - id: prod-blast-radius
    when:
      filePaths: ["environments/prod/**/*"]
      changePercentage:
        totalGte: 30
    severity: high
    reviewers:
      teams: [sre-team]
```

### Security Review

```yaml
rules:
  # All IAM changes need security review
  - id: iam-review
    when:
      categories: ["iam"]
    severity: high
    reviewers:
      teams: [security-team]

  # IAM deletions need security lead approval
  - id: iam-deletions
    when:
      categories: ["iam"]
      actions: [delete]
    severity: critical
    reviewers:
      users: [security-lead]
```

### Database Governance

```yaml
rules:
  # Multiple database deletions
  - id: db-mass-deletion
    when:
      categories: ["database"]
      actions: [delete]
      changeCount:
        deleteGte: 2
    severity: critical
    reviewers:
      teams: [dba-team]

  # Multiple database additions
  - id: db-create-volume
    when:
      categories: ["database"]
      actions: [create]
      changeCount:
        createGte: 3
    severity: high
```

### Multi-Cloud Consistency

```yaml
rules:
  # Consistent compute review across clouds
  - id: compute-changes
    when:
      categories: ["compute"]
      changeCount:
        totalGte: 5
    severity: medium
    reviewers:
      teams: [platform-team]

  # Network changes anywhere
  - id: network-changes
    when:
      categories: ["network"]
    severity: high
    reviewers:
      teams: [network-team, security-team]
```

## Configuration Reference

### Full Rule Structure

```yaml
version: 1

defaults:
  reviewers:
    teams: [default-team]
    users: []

rules:
  - id: unique-rule-id
    description: Human-readable description
    when:
      # Resource filtering (all optional, AND logic)
      resourceTypes: ["aws_instance", "aws_db_*"]
      services: ["aws:ec2", "aws:rds"]
      categories: ["compute", "database"]
      moduleAddress: "module.database*"

      # Action filtering
      actions: [create, update, delete, replace, import]

      # Location filtering
      filePaths: ["environments/prod/**/*"]

      # Volume constraints
      changeCount:
        createGte: 5
        updateGte: 10
        deleteGte: 3
        replaceGte: 2
        importGte: 1
        totalGte: 20
      changePercentage:
        createGte: 10
        totalGte: 25

    # Severity escalation
    severity: low | medium | high | critical

    # Reviewer assignment (optional)
    reviewers:
      teams: [team-a, team-b]
      users: [user-a, user-b]

    # Notifications (optional)
    notify:
      slack: security-alerts
```

### Evaluation Order

Rules are evaluated in file order. Severity escalates based on matches:

1. `low` → `medium` → `high` → `critical`
2. Reviewers are unioned from all matched rules
3. Notifications trigger based on final severity

### Condition Logic

Within a rule, all conditions use **AND logic**:

```yaml
when:
  categories: ["database"] # Must be a database AND
  actions: ["delete"] # Must be a delete AND
  changeCount: # Must have 2+ deletes
    deleteGte: 2
```

Multiple values in an array use **OR logic**:

```yaml
when:
  categories: ["iam", "database"] # IAM OR database
  actions: [create, update] # Create OR update
```

## Taxonomy Reference

See [TAXONOMY.md](./TAXONOMY.md) for:

- Complete list of supported services by provider
- Category descriptions and example resources
- Volume constraint usage
- Evaluation order details

## Support

- Documentation: https://docs.mergewire.app
- Issues: https://github.com/mergewire/mergewire/issues
- Email: support@mergewire.app
