# MergeWire Resource Taxonomy

The MergeWire resource taxonomy provides a curated mapping of Terraform resource types to their cloud services and high-level categories. This enables powerful abstractions for multi-cloud infrastructure management.

## Overview

### What is the Taxonomy?

The taxonomy maps Terraform resource types (like `aws_iam_role`, `google_compute_instance`) to:

1. **Cloud Provider** (`aws`, `gcp`, `azure`)
2. **Service** (`iam`, `ec2`, `compute`, `s3`, etc.)
3. **Categories** (`iam`, `network`, `compute`, `storage`, `database`, `security`, `monitoring`)

### Why Use It?

Instead of listing every individual Terraform resource type:

```yaml
# ❌ Before: Tedious and error-prone
resourceTypes:
  - aws_iam_role
  - aws_iam_policy
  - aws_iam_user
  - aws_iam_group
  - aws_iam_role_policy
  # ... and 20 more IAM resources

# ✅ After: Simple and future-proof
categories: ["iam"]
# OR
services: ["aws:iam"]
```

## Categories

Categories provide cross-cloud abstractions. A single category can match resources from AWS, GCP, and Azure.

| Category     | Description                  | Example Resources                                                                 |
| ------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| `iam`        | Identity & Access Management | `aws_iam_role`, `google_service_account`, `azurerm_role_assignment`               |
| `network`    | Networking & Connectivity    | `aws_vpc`, `google_compute_network`, `azurerm_virtual_network`                    |
| `compute`    | Compute Resources            | `aws_instance`, `google_compute_instance`, `azurerm_linux_virtual_machine`        |
| `storage`    | Storage Services             | `aws_s3_bucket`, `google_storage_bucket`, `azurerm_storage_account`               |
| `database`   | Database Services            | `aws_db_instance`, `google_sql_database`, `azurerm_mssql_server`                  |
| `security`   | Security Resources           | `aws_security_group`, `google_compute_firewall`, `azurerm_network_security_group` |
| `monitoring` | Observability                | `aws_cloudwatch_dashboard`, `google_monitoring_alert_policy`                      |

### Using Categories

```yaml
# Match any IAM resource across all clouds
- id: cross-cloud-iam
  when:
    categories: ["iam"]
  severity: high

# Match multiple categories (OR logic)
- id: critical-categories
  when:
    categories: ["iam", "database", "security"]
  severity: critical

# Combine with other conditions
- id: prod-database-deletions
  when:
    categories: ["database"]
    actions: ["delete"]
    filePaths: ["environments/prod/**/*"]
  severity: critical
```

## Services

Services identify resources by their cloud provider service. Use the format `provider:service` for specific providers, or just `service` for cross-provider matching.

### AWS Services

| Service           | Pattern                                       | Example Resources                  |
| ----------------- | --------------------------------------------- | ---------------------------------- |
| `aws:iam`         | `aws_iam_*`                                   | IAM roles, policies, users, groups |
| `aws:vpc`         | `aws_vpc`, `aws_subnet`, `aws_security_group` | VPC networking                     |
| `aws:ec2`         | `aws_instance`, `aws_launch_template`         | Virtual machines                   |
| `aws:eks`         | `aws_eks_*`                                   | Kubernetes clusters                |
| `aws:lambda`      | `aws_lambda_*`                                | Serverless functions               |
| `aws:s3`          | `aws_s3_*`                                    | Object storage                     |
| `aws:rds`         | `aws_rds_*`, `aws_db_instance`                | Relational databases               |
| `aws:dynamodb`    | `aws_dynamodb_*`                              | NoSQL databases                    |
| `aws:elasticache` | `aws_elasticache_*`                           | Caching services                   |
| `aws:elbv2`       | `aws_lb`, `aws_alb`, `aws_nlb`                | Load balancers                     |
| `aws:ecs`         | `aws_ecs_*`                                   | Container service                  |
| `aws:cloudwatch`  | `aws_cloudwatch_*`                            | Monitoring                         |

### GCP Services

| Service              | Pattern                                | Example Resources    |
| -------------------- | -------------------------------------- | -------------------- |
| `gcp:iam`            | `google_iam_*`, `google_project_iam_*` | IAM resources        |
| `gcp:compute`        | `google_compute_*`                     | Compute & networking |
| `gcp:container`      | `google_container_*`                   | GKE clusters         |
| `gcp:cloudfunctions` | `google_cloudfunctions_*`              | Cloud Functions      |
| `gcp:storage`        | `google_storage_*`                     | Cloud Storage        |
| `gcp:sql`            | `google_sql_*`                         | Cloud SQL            |
| `gcp:bigtable`       | `google_bigtable_*`                    | Bigtable             |
| `gcp:spanner`        | `google_spanner_*`                     | Cloud Spanner        |
| `gcp:monitoring`     | `google_monitoring_*`                  | Cloud Monitoring     |

### Azure Services

| Service                  | Pattern                               | Example Resources  |
| ------------------------ | ------------------------------------- | ------------------ |
| `azure:authorization`    | `azurerm_role_*`                      | RBAC resources     |
| `azure:msi`              | `azurerm_*identity*`                  | Managed identities |
| `azure:network`          | `azurerm_*network*`, `azurerm_subnet` | Networking         |
| `azure:lb`               | `azurerm_lb*`                         | Load balancers     |
| `azure:compute`          | `azurerm_*virtual_machine*`           | VMs & scale sets   |
| `azure:containerservice` | `azurerm_kubernetes_cluster*`         | AKS clusters       |
| `azure:web`              | `azurerm_function_app`                | Azure Functions    |
| `azure:storage`          | `azurerm_storage_*`                   | Storage accounts   |
| `azure:sql`              | `azurerm_mssql_*`                     | SQL Server         |
| `azure:postgresql`       | `azurerm_postgresql_*`                | PostgreSQL         |
| `azure:mysql`            | `azurerm_mysql_*`                     | MySQL              |
| `azure:cosmosdb`         | `azurerm_cosmosdb_*`                  | Cosmos DB          |
| `azure:monitor`          | `azurerm_monitor_*`                   | Azure Monitor      |

### Using Services

```yaml
# Match specific provider service
- id: aws-lambda-changes
  when:
    services: ["aws:lambda"]
  severity: medium

# Match service across all providers (cross-cloud)
- id: any-kubernetes
  when:
    services: ["eks", "container", "containerservice"]
  severity: high

# Multiple services (OR logic)
- id: compute-services
  when:
    services: ["aws:ec2", "aws:eks", "gcp:compute"]
  severity: medium
```

## Volume Constraints

Volume constraints let you limit the "blast radius" of changes. They work by counting resources or calculating percentages AFTER filtering by type/service/category.

### changeCount

Set fixed thresholds for change volumes:

```yaml
- id: delete-limit
  when:
    actions: ["delete"]
    changeCount:
      deleteGte: 5 # Trigger if 5+ deletes
      totalGte: 10 # OR if 10+ total changes
  severity: high
```

**Available fields:**

- `createGte` - Minimum creations
- `updateGte` - Minimum updates
- `deleteGte` - Minimum deletions
- `replaceGte` - Minimum replacements
- `importGte` - Minimum imports
- `totalGte` - Minimum total changes

### changePercentage

Set proportional thresholds (requires `totalStateResources` in payload):

```yaml
- id: proportional-blast-radius
  when:
    categories: ["database"]
    changePercentage:
      totalGte: 50 # Trigger if >50% of databases change
  severity: critical
```

**Available fields:**

- `createGte` - Percentage of state being created
- `updateGte` - Percentage of state being updated
- `deleteGte` - Percentage of state being deleted
- `replaceGte` - Percentage of state being replaced
- `totalGte` - Percentage of state with any change

### Volume + Filter Intersection

Volume constraints are evaluated AFTER filtering, enabling precise targeting:

```yaml
# Only triggers if 3+ RDS databases are being deleted in production
- id: rds-delete-blast-radius
  when:
    services: ["aws:rds"]
    actions: ["delete"]
    filePaths: ["environments/prod/**/*"]
    changeCount:
      deleteGte: 3
  severity: critical
```

## Complete Examples

### Example 1: Production Blast Radius Protection

```yaml
rules:
  # Prevent mass deletions in production
  - id: prod-mass-deletion
    description: Cannot delete 5+ resources in production
    when:
      actions: ['delete']
      filePaths: ['environments/prod/**/*']
      changeCount:
        deleteGte: 5
    severity: critical
    reviewers:
      teams: [sre-team]

  # Alert on high percentage of infrastructure changes
  - id: prod-high-blast-radius
    description: >50% of production resources changing
    when:
      filePaths: ['environments/prod/**/*']
      changePercentage:
        totalGte: 50
    severity: high
    reviewers:
      teams: [sre-team, architecture-team]
```

### Example 2: Cross-Cloud Security Policy

```yaml
rules:
  # Any IAM deletions require security lead approval
  - id: global-iam-deletions
    description: IAM deletions across any cloud
    when:
      categories: ['iam']
      actions: ['delete', 'replace']
    severity: critical
    reviewers:
      teams: [security-team]
      users: [security-lead]

  # Security group changes in any cloud
  - id: security-group-changes
    description: Firewall/security group changes
    when:
      categories: ['security']
      categories: ['network', 'security']  # Resources with BOTH categories
    severity: high
    reviewers:
      teams: [security-team, network-team]
```

### Example 3: Database Governance

```yaml
rules:
  # Multiple database deletions
  - id: database-deletion-limit
    description: Cannot delete 2+ databases at once
    when:
      categories: ["database"]
      actions: ["delete"]
      changeCount:
        deleteGte: 2
    severity: critical
    reviewers:
      teams: [dba-team]
      users: [cto]

  # Expensive database additions with volume
  - id: database-cost-and-volume
    description: Multiple expensive database additions
    when:
      categories: ["database"]
      actions: ["create"]
      changeCount:
        createGte: 3
    severity: high
```

### Example 4: Service-Specific Policies

```yaml
rules:
  # Lambda function limits
  - id: lambda-deployment-limit
    description: Mass Lambda deployments need review
    when:
      services: ["aws:lambda"]
      actions: ["create", "update"]
      changeCount:
        totalGte: 10
    severity: medium
    reviewers:
      teams: [serverless-team]

  # EKS cluster critical changes
  - id: eks-critical-changes
    description: EKS cluster node group or addon changes
    when:
      services: ["aws:eks"]
      resourceTypes:
        - aws_eks_node_group
        - aws_eks_addon
    severity: high
    reviewers:
      teams: [platform-team, kubernetes-team]
```

## Evaluation Order

When a rule has multiple conditions, they are evaluated in this order:

1. **Resource Type Filters**
   - `resourceTypes` - Exact patterns and globs
   - `services` - Provider:service matching
   - `categories` - High-level category matching
   - `moduleAddress` - Module path matching

2. **Action Filter**
   - `actions` - What operations are being performed

3. **Location Filter**
   - `filePaths` - Where the code lives

4. **Volume Constraints**
   - `changeCount` - Fixed thresholds
   - `changePercentage` - Proportional thresholds (requires `totalStateResources`)

5. **Cost Constraints**
   - `cost.monthlyDeltaUsdGte` - Cost threshold

All conditions use AND logic (intersection). A rule only matches if ALL its conditions are satisfied.

## Future-Proofing

Using services and categories makes your rules resilient to:

- **New resource types**: When AWS adds `aws_iam_new_feature`, `services: ['aws:iam']` automatically matches it
- **Multi-cloud adoption**: `categories: ['database']` works whether you're on AWS, GCP, or Azure
- **Refactoring**: Moving from `aws_db_instance` to `aws_rds_cluster` doesn't break `services: ['aws:rds']`

## Adding to Taxonomy

The taxonomy is extensible. To request new mappings:

1. Open an issue at https://github.com/mergewire/mergewire/issues
2. Provide the Terraform resource type pattern
3. Suggest the service and categories

Or contribute directly by editing `packages/rules/src/taxonomy.ts`.
