import type { AnalysisReport } from '../types.ts';

export function formatJson(report: AnalysisReport): string {
  return JSON.stringify(report, null, 2);
}
