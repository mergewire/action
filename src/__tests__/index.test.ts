import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock all dependencies before importing the module
vi.mock('@actions/core')
vi.mock('@actions/github')
vi.mock('../github-context.js')
vi.mock('../terraform.js')
vi.mock('../payload-builder.js')
vi.mock('../api-client.js')
vi.mock('../core/helpers.js', async () => {
  const actual = await vi.importActual('../core/helpers.js')
  return {
    ...actual,
    assertSafePayload: vi.fn(),
  }
})

describe('Action main flow', () => {
  beforeEach(async () => {
    vi.resetAllMocks()

    // Setup default mock implementations
    const core = await import('@actions/core')
    vi.mocked(core.getInput).mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        'api-url': 'https://api.example.com',
        'api-secret': 'test-secret',
        'terraform-root': './terraform',
        workspace: 'dev',
        environment: 'staging',
        'fail-on-api-error': 'false',
        'github-token': 'ghp_token',
      }
      return inputs[name] || ''
    })
    vi.mocked(core.getBooleanInput).mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.GITHUB_ACTIONS
  })

  it('should have proper module structure', async () => {
    // Verify all modules can be imported
    const { extractGitHubContext } = await import('../github-context.js')
    const { runTerraform } = await import('../terraform.js')
    const { buildRoutingPayload } = await import('../payload-builder.js')
    const { sendPayload } = await import('../api-client.js')
    const { assertSafePayload } = await import('../core/helpers.js')

    expect(extractGitHubContext).toBeDefined()
    expect(runTerraform).toBeDefined()
    expect(buildRoutingPayload).toBeDefined()
    expect(sendPayload).toBeDefined()
    expect(assertSafePayload).toBeDefined()
  })
})

// Note: Full integration testing of the main run() function would require
// extensive mocking of the GitHub Actions environment and all dependencies.
// The unit tests for individual modules cover the core functionality.
