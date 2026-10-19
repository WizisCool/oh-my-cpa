import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { appendProbeTiming } from '../acceptance/probe-timings.mjs';

export default class ProbeReporter implements Reporter {
  private readonly file: string;
  private hasFailed = false;

  constructor({ file }: { file: string }) { this.file = file; }

  onTestEnd(test: TestCase, result: TestResult) {
    try {
      const id = test.annotations.find(annotation => annotation.type === 'scenario')?.description;
      if (!id) throw new Error(`Missing scenario identity: ${test.title}`);
      const error = appendProbeTiming(this.file, {
        id, durationMs: result.duration,
        status: result.status === 'passed' ? 'passed' : 'failed',
        steps: result.steps.filter(step => step.category === 'test.step')
          .map(step => ({ name: step.title, durationMs: step.duration })),
      });
      if (error) throw error;
    } catch (error) {
      // Reporter callbacks are not test assertions. Make damaged evidence part of
      // the runner verdict instead of relying on a logged reporter exception.
      this.hasFailed = true;
      console.error('Probe timing evidence failed:', error);
    }
  }

  async onEnd(): Promise<{ status: 'failed' } | void> {
    if (this.hasFailed) return { status: 'failed' };
  }
}
