/**
 * Terraform Execution
 *
 * Runs terraform init, plan, and show commands to get the JSON plan output.
 */

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as path from 'path'
import * as fs from 'fs'

export interface TerraformPlanResult {
  planJson: unknown
  binarySize: number
}

const PLAN_FILE = 'tfplan.bin'

/**
 * Run Terraform init and plan commands
 * @param terraformRoot - Path to the Terraform directory
 * @param workspace - Optional workspace to select
 * @returns The parsed plan JSON and binary size
 * @throws Error if Terraform commands fail
 */
export async function runTerraform(
  terraformRoot: string,
  workspace?: string
): Promise<TerraformPlanResult> {
  const cwd = path.resolve(terraformRoot)

  // Verify directory exists
  if (!fs.existsSync(cwd)) {
    throw new Error(`Terraform root directory does not exist: ${terraformRoot}`)
  }

  // Run terraform init
  core.info('  Running terraform init...')
  await execTerraform(['init', '-no-color'], cwd)

  // Select workspace if provided
  if (workspace) {
    core.info(`  Selecting workspace: ${workspace}...`)
    try {
      await execTerraform(['workspace', 'select', workspace], cwd)
    } catch {
      core.info(`    Workspace ${workspace} does not exist, creating...`)
      await execTerraform(['workspace', 'new', workspace], cwd)
    }
  }

  // Run terraform plan
  core.info('  Running terraform plan...')
  const planFile = path.join(cwd, PLAN_FILE)
  await execTerraform(['plan', '-out', PLAN_FILE, '-no-color', '-input=false'], cwd)

  // Get binary plan size
  const binarySize = fs.statSync(planFile).size

  // Run terraform show to get JSON
  core.info('  Converting plan to JSON...')
  const planJson = await execTerraformShow(cwd)

  // Cleanup
  try {
    fs.unlinkSync(planFile)
  } catch {
    // Ignore cleanup errors
  }

  return {
    planJson,
    binarySize,
  }
}

/**
 * Execute a Terraform command
 */
async function execTerraform(args: string[], cwd: string): Promise<void> {
  const options = {
    cwd,
    silent: true, // Don't print stdout to avoid leaking sensitive data
    ignoreReturnCode: false,
  }

  let stderr = ''
  const exitCode = await exec.exec('terraform', args, {
    ...options,
    listeners: {
      stderr: (data: Buffer) => {
        stderr += data.toString()
      },
    },
  })

  if (exitCode !== 0) {
    // Log stderr for debugging (Terraform doesn't output secrets to stderr typically)
    core.debug(`Terraform stderr: ${stderr}`)
    throw new Error(`Terraform command failed with exit code ${exitCode}: ${stderr.slice(0, 500)}`)
  }
}

/**
 * Execute terraform show -json and parse the output
 */
async function execTerraformShow(cwd: string): Promise<unknown> {
  const planFile = path.join(cwd, PLAN_FILE)
  let stdout = ''
  let stderr = ''

  const exitCode = await exec.exec('terraform', ['show', '-json', planFile], {
    cwd,
    silent: true,
    ignoreReturnCode: false,
    listeners: {
      stdout: (data: Buffer) => {
        stdout += data.toString()
      },
      stderr: (data: Buffer) => {
        stderr += data.toString()
      },
    },
  })

  if (exitCode !== 0) {
    throw new Error(`terraform show failed: ${stderr.slice(0, 500)}`)
  }

  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(
      `Failed to parse terraform show output as JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Check if Terraform is installed
 */
export async function isTerraformInstalled(): Promise<boolean> {
  try {
    await exec.exec('terraform', ['version'], { silent: true })
    return true
  } catch {
    return false
  }
}

/**
 * Validate Terraform configuration
 */
export async function validateTerraform(cwd: string): Promise<void> {
  await execTerraform(['validate', '-no-color'], cwd)
}
