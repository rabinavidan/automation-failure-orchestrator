import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Drift guard for azure-pipelines.yml. GitHub Actions is the primary CI; the Azure DevOps
 * pipeline must run the same gates with the same pinned tool versions, or this test fails.
 */
const ROOT = join(__dirname, '../../../..');
const read = (path: string) => parse(readFileSync(join(ROOT, path), 'utf-8'));

interface GhStep {
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}
interface AdoStep {
  script?: string;
  template?: string;
  task?: string;
  parameters?: Record<string, string>;
  inputs?: Record<string, string>;
}
interface AdoJob {
  job: string;
  steps: AdoStep[];
}
interface AdoPipeline {
  variables: Record<string, string>;
  stages: Array<{ stage: string; dependsOn?: string; jobs: AdoJob[] }>;
}

const gh = read('.github/workflows/ci.yml') as { jobs: Record<string, { steps: GhStep[] }> };
const ado = read('azure-pipelines.yml') as AdoPipeline;
const adoJobs = ado.stages.flatMap((s) => s.jobs);

/** Template steps are inlined so commands inside templates count. */
function expandSteps(steps: AdoStep[], from = ROOT): AdoStep[] {
  return steps.flatMap((step) => {
    if (!step.template) return [step];
    const path = join(from, step.template);
    const template = parse(readFileSync(path, 'utf-8')) as { steps: AdoStep[] };
    return expandSteps(template.steps, dirname(path));
  });
}

const adoCommands = new Set(
  adoJobs
    .flatMap((j) => expandSteps(j.steps))
    .flatMap((s) => (s.script ?? '').split('\n'))
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
);

function ghStep(job: string, predicate: (s: GhStep) => boolean): GhStep {
  const step = gh.jobs[job].steps.find(predicate);
  if (!step) throw new Error(`ci.yml job ${job} has no matching step`);
  return step;
}

describe('Azure DevOps pipeline (azure-pipelines.yml)', () => {
  it('pins the same tool versions as GitHub Actions', () => {
    const node = ghStep('quality', (s) => s.uses?.startsWith('actions/setup-node') ?? false);
    const python = ghStep(
      'python-quality',
      (s) => s.uses?.startsWith('actions/setup-python') ?? false
    );
    const terraform = ghStep(
      'terraform',
      (s) => s.uses?.startsWith('hashicorp/setup-terraform') ?? false
    );
    const checkov = ghStep('terraform', (s) => s.run?.includes('checkov==') ?? false);

    expect(ado.variables.nodeVersion).toBe(String(node.with?.['node-version']));
    expect(ado.variables.pythonVersion).toBe(String(python.with?.['python-version']));
    expect(ado.variables.terraformVersion).toBe(String(terraform.with?.terraform_version));
    expect(checkov.run).toContain(`checkov==${ado.variables.checkovVersion}`);
  });

  it.each(['quality', 'python-quality', 'terraform', 'production-dependencies', 'container-smoke'])(
    'runs every command of the GitHub Actions %s job',
    (job) => {
      const commands = gh.jobs[job].steps
        .flatMap((s) => (s.run ?? '').split('\n'))
        .map((line) => line.trim().replace(/\s+/g, ' '))
        .filter((line) => line && !line.startsWith('pip install --quiet checkov'));
      for (const command of commands) {
        const normalized = command.replace(/\$\{\{[^}]+\}\}/g, '').trim();
        const found = [...adoCommands].some((c) => c.includes(normalized));
        expect(found, `missing in azure-pipelines.yml: ${command}`).toBe(true);
      }
    }
  );

  it('scans every runtime image with the same Trivy gate as GitHub Actions', () => {
    const gate = ghStep('image-security', (s) => s.uses?.startsWith('aquasecurity/trivy') ?? false);
    expect(gate.with).toMatchObject({
      'exit-code': '1',
      'ignore-unfixed': true,
      severity: 'CRITICAL',
    });

    const imageJob = adoJobs.find((j) => j.job === 'image_security')!;
    const scanned = imageJob.steps
      .filter((s) => s.template?.endsWith('image-scan.yml'))
      .map((s) => s.parameters?.image?.split(':')[0]);
    expect(scanned.sort()).toEqual([
      'orchestrator-dashboard',
      'orchestrator-enrichment',
      'orchestrator-ingestion',
    ]);
    const scan = expandSteps([imageJob.steps.find((s) => s.template)!])[0].script!;
    expect(scan).toContain('--exit-code 1');
    expect(scan).toContain('--ignore-unfixed');
    expect(scan).toContain('--severity CRITICAL');
  });

  it('gates containers on quality and publishes versioned images only from main', () => {
    const containers = ado.stages.find((s) => s.stage === 'Containers')!;
    expect(containers.dependsOn).toBe('Quality');
    const publish = adoJobs
      .flatMap((j) => j.steps)
      .find((s) => s.task === 'PublishPipelineArtifact@1')!;
    expect(publish.inputs?.artifact).toBe('images-$(imageTag)');
    expect((publish as { condition?: string }).condition).toContain("'refs/heads/main'");
  });

  it('references only templates that exist and needs no secrets or deployments', () => {
    for (const job of adoJobs) {
      for (const step of job.steps.filter((s) => s.template)) {
        expect(existsSync(join(ROOT, step.template!)), step.template).toBe(true);
      }
    }
    const raw = readFileSync(join(ROOT, 'azure-pipelines.yml'), 'utf-8');
    expect(raw).not.toMatch(/deployment:|AzureCLI@|AzureWebApp@|variableGroup|group:/);
  });
});
