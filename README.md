# MergeWire GitHub Action

The MergeWire Action runs Terraform inside CI, reduces the plan to routing-safe metadata (including `pullRequest.author`), and sends that payload to the MergeWire API.

## Account-first setup

Before using the Action:

1. Sign up in MergeWire
2. Create a workspace
3. Generate a workspace API key
4. Add these GitHub secrets:
   - `MERGEWIRE_API_URL`
   - `MERGEWIRE_API_KEY`

## Usage

```yaml
name: Terraform Review

on:
  pull_request:
    paths:
      - "**.tf"
      - "**.tfvars"
      - ".mergewire.yml"

jobs:
  terraform-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.7.0"

      - uses: mergewire/action@v1
        with:
          api-url: ${{ secrets.MERGEWIRE_API_URL }}
          api-key: ${{ secrets.MERGEWIRE_API_KEY }}
          terraform-root: ./infrastructure
          workspace: production
          environment: prod
          fail-on-api-error: false
```

## Inputs

| Input               | Required    | Description                           |
| ------------------- | ----------- | ------------------------------------- |
| `api-url`           | yes         | MergeWire API base URL                |
| `api-key`           | recommended | Workspace API key for ingest auth     |
| `api-secret`        | legacy      | Deprecated compatibility input        |
| `terraform-root`    | yes         | Relative Terraform root               |
| `workspace`         | no          | Terraform workspace label             |
| `environment`       | no          | Environment label                     |
| `fail-on-api-error` | no          | Fail workflow on API delivery failure |
| `github-token`      | no          | Token for listing changed PR files    |

## `.mergewire.yml`

MergeWire keeps repo-specific policy in `.mergewire.yml`.

Important behavior:

- Free workspaces can reach first value without custom policy
- built-in behavior still routes the first PR on Free
- paid plans can unlock repo-specific custom rule behavior

Minimal example:

```yaml
version: 1

defaults:
  reviewers:
    teams:
      - platform-team
    users: []

rules:
  - id: destructive
    description: Escalate destructive changes
    when:
      actions:
        - delete
        - replace
    severity: high
    reviewers:
      teams:
        - sre-team
      users: []
```

## Security model

- the Action authenticates with a workspace API key
- the backend stores only a hash of that key
- the Action still sends a legacy signature header for compatibility during migration
- the Action never sends raw Terraform values or full plan JSON

## Outputs

| Output           | Description                                     |
| ---------------- | ----------------------------------------------- |
| `request-id`     | Correlation id for backend ingest               |
| `routing-status` | `accepted`, `duplicate`, `skipped`, or `failed` |
| `summary-json`   | Compact execution summary                       |

## Documentation
https://mergewire.app/docs
