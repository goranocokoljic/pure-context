/**
 * plan-refactoring.ts
 *
 * MCP tool: plan_refactoring
 *
 * Synthesize the outputs of check_rename_safe, check_delete_safe,
 * check_move_safe, find_cycles, get_coupling_map, detect_antipatterns, and
 * get_quality_metrics into a sequenced, risk-annotated refactoring plan.
 *
 * This tool is read-only — it produces a plan but writes nothing.
 * Execution of the plan is left to the calling agent.
 *
 * Supported goals:
 *   'rename-symbol'   — rename a symbol everywhere (requires symbolId + newName)
 *   'delete-symbol'   — safely remove a symbol and its references (requires symbolId)
 *   'break-cycle'     — resolve a circular import dependency (requires filePath or symbolId)
 *   'extract-module'  — move a file to a new location (requires filePath + newFilePath)
 *   'reduce-coupling' — split a highly-coupled file (requires filePath or symbolId)
 *   'general'         — open-ended analysis, surfaces top findings (requires filePath or symbolId)
 *
 * Step ordering:
 *   Always edit leaf files before hub files (bottom-up). For rename: update all call/import
 *   sites first, then rename the declaration last. For delete: remove all references first,
 *   then delete the declaration last.
 */

import { z } from 'zod';
import { openDatabase, getRepo } from '../../core/db/schema.js';
import { getSymbolById } from '../../core/db/symbol-store.js';
import { buildMeta } from './_meta.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Sub-tool handlers — each opens/closes its own DB connection
import { handler as checkRenameSafeHandler } from './check-rename-safe.js';
import { handler as checkDeleteSafeHandler } from './check-delete-safe.js';
import { handler as checkMoveSafeHandler } from './check-move-safe.js';
import { handler as findCyclesHandler } from './find-cycles.js';
import { handler as getCouplingMapHandler } from './get-coupling-map.js';
import { handler as detectAntipatternsHandler } from './detect-antipatterns.js';
import { handler as getQualityMetricsHandler } from './get-quality-metrics.js';

// ─── Goal type ────────────────────────────────────────────────────────────────

const refactoringGoalEnum = z.enum([
  'extract-module',
  'rename-symbol',
  'delete-symbol',
  'break-cycle',
  'reduce-coupling',
  'general',
]);

type RefactoringGoal = z.infer<typeof refactoringGoalEnum>;

export const name = 'plan_refactoring';

export const description =
  'Generate a sequenced, risk-annotated refactoring plan for a symbol or file. ' +
  'Synthesizes check_rename_safe, check_delete_safe, check_move_safe, find_cycles, ' +
  'get_coupling_map, detect_antipatterns, and get_quality_metrics into a prioritised ' +
  'step list. Read-only — produces a plan but writes nothing. ' +
  'Goals: rename-symbol (symbolId + newName), delete-symbol (symbolId), ' +
  'break-cycle (filePath or symbolId), extract-module (filePath + newFilePath), ' +
  'reduce-coupling (filePath or symbolId), general (filePath or symbolId).';

export const inputSchema = {
  repoId: z.string().describe('Repo ID from index_folder or resolve_repo'),
  symbolId: z
    .string()
    .optional()
    .describe(
      'Symbol ID of the target symbol. Required for rename-symbol and delete-symbol. ' +
      'Used to derive filePath for break-cycle, reduce-coupling, and general when filePath is omitted.',
    ),
  filePath: z
    .string()
    .optional()
    .describe(
      'File path relative to the repo root. Required for extract-module and reduce-coupling ' +
      'when symbolId is not provided. Used as scope for break-cycle and general.',
    ),
  goal: refactoringGoalEnum.describe(
    'Refactoring goal: rename-symbol, delete-symbol, break-cycle, extract-module, ' +
    'reduce-coupling, or general.',
  ),
  newName: z
    .string()
    .optional()
    .describe('Proposed new name. Required for rename-symbol.'),
  newFilePath: z
    .string()
    .optional()
    .describe('Proposed new file location (relative to repo root). Required for extract-module.'),
  contextHint: z
    .string()
    .optional()
    .describe(
      'Free-text description of what you are trying to achieve. ' +
      'Included verbatim in the plan summary.',
    ),
};

// ─── Output types ─────────────────────────────────────────────────────────────

export interface RefactoringStep {
  order: number;
  action: string;
  filePath: string;
  line?: number;
  detail: string;
  automated: boolean;
  risk: 'low' | 'medium' | 'high';
}

interface PlanRefactoringOutput {
  goal: RefactoringGoal;
  summary: string;
  steps: RefactoringStep[];
  totalSteps: number;
  estimatedRisk: 'low' | 'medium' | 'high';
  warnings: string[];
  _tokenEstimate: number;
  _meta: ReturnType<typeof buildMeta>;
}

// ─── Inline sub-tool response types ──────────────────────────────────────────

interface AffectedSite {
  filePath: string;
  line: number;
  column: number;
  context: string;
  changeType: 'call' | 'import' | 'type-reference' | 'string-literal' | 'comment';
}

interface CheckRenameSafeResult {
  safe: boolean;
  symbolName: string;
  newName: string;
  conflicts: string[];
  affectedSites: AffectedSite[];
  affectedFileCount: number;
}

interface DeleteRisk {
  kind: 'live-reference' | 'exported-symbol' | 'entry-point' | 'test-subject';
  filePath: string;
  line?: number;
  detail: string;
}

interface CheckDeleteSafeResult {
  safe: boolean;
  risks: DeleteRisk[];
  liveReferenceCount: number;
  isExported: boolean;
  isEntryPoint: boolean;
}

interface ImportUpdate {
  importerFilePath: string;
  currentImportPath: string;
  newImportPath: string;
  line: number;
}

interface CheckMoveSafeResult {
  safe: boolean;
  importUpdates: ImportUpdate[];
  newCycles: string[][];
  wouldIntroduceCycles: boolean;
}

interface CyclePath {
  files: string[];
  length: number;
  severity: 'warning' | 'error';
}

interface FindCyclesResult {
  cycles: CyclePath[];
  totalFound: number;
}

interface FileCoupling {
  filePath: string;
  efferentCoupling: number;
  afferentCoupling: number;
  instability: number;
  efferentDeps: string[];
  afferentDeps: string[];
}

interface GetCouplingMapResult {
  files: FileCoupling[];
}

interface AntipatternFinding {
  check: string;
  severity: 'warning' | 'error';
  filePath: string;
  symbolName?: string;
  description: string;
  suggestion: string;
}

interface DetectAntipatternsResult {
  findings: AntipatternFinding[];
  findingsCount: number;
}

interface SymbolQualityRecord {
  symbolId: string;
  name: string;
  filePath: string;
  qualityScore: number;
  riskLevel: 'good' | 'moderate' | 'high' | 'critical';
  cyclomaticComplexity: number;
  lineCount: number;
}

interface GetQualityMetricsResult {
  worstOffenders: SymbolQualityRecord[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a CallToolResult, returning null if isError is true.
 * Throws on JSON parse failure.
 */
function parseResult<T>(result: CallToolResult): T | null {
  if (result.isError) return null;
  const text = (result.content[0] as { text: string }).text;
  return JSON.parse(text) as T;
}

/** Aggregate risk: return the worst of all step risks. */
function aggregateRisk(steps: RefactoringStep[]): 'low' | 'medium' | 'high' {
  if (steps.some((s) => s.risk === 'high')) return 'high';
  if (steps.some((s) => s.risk === 'medium')) return 'medium';
  return 'low';
}

/** Number steps starting from 1. */
function numberSteps(steps: RefactoringStep[]): RefactoringStep[] {
  return steps.map((s, i) => ({ ...s, order: i + 1 }));
}

// ─── Goal implementations ─────────────────────────────────────────────────────

async function planRenameSymbol(
  repoId: string,
  symbolId: string,
  symbolName: string,
  symbolFilePath: string,
  newName: string,
): Promise<{ steps: RefactoringStep[]; warnings: string[]; summary: string }> {
  const warnings: string[] = [];

  const renameResult = await checkRenameSafeHandler({ repoId, symbolId, newName });
  const renameData = parseResult<CheckRenameSafeResult>(renameResult);

  if (!renameData) {
    return {
      steps: [],
      warnings: ['check_rename_safe returned an error — cannot generate rename plan.'],
      summary: `Cannot plan rename of "${symbolName}" → "${newName}": safety check failed.`,
    };
  }

  if (renameData.conflicts.length > 0) {
    warnings.push(
      `"${newName}" conflicts with an existing symbol in ${symbolFilePath}. ` +
      'Resolve the conflict before proceeding.',
    );
  }

  const steps: RefactoringStep[] = [];

  // Separate sites by type for ordering:
  // imports → call sites → type-refs → comments (all before declaration)
  const importSites = renameData.affectedSites.filter((s) => s.changeType === 'import');
  const callSites = renameData.affectedSites.filter((s) => s.changeType === 'call');
  const typeRefSites = renameData.affectedSites.filter((s) => s.changeType === 'type-reference');
  const commentSites = renameData.affectedSites.filter((s) => s.changeType === 'comment');
  const stringLitSites = renameData.affectedSites.filter((s) => s.changeType === 'string-literal');

  if (stringLitSites.length > 0) {
    warnings.push(
      `${stringLitSites.length} string-literal reference(s) to "${symbolName}" require manual update ` +
      '— a text rename will not fix dynamic string usage.',
    );
  }

  // Add call/import/type-ref steps (bottom-up: leaf callers first via file sort)
  // Sort by filePath — a reasonable proxy for bottom-up when no topology is available
  const referenceOrdered = [...importSites, ...callSites, ...typeRefSites]
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

  for (const site of referenceOrdered) {
    steps.push({
      order: 0,
      action: `Update ${site.changeType} in ${site.filePath} line ${site.line}`,
      filePath: site.filePath,
      line: site.line,
      detail: `Rename "${symbolName}" to "${newName}". Context: ${site.context.trim()}`,
      automated: true,
      risk: 'low',
    });
  }

  // Comment sites — informational, not blocking
  for (const site of commentSites) {
    steps.push({
      order: 0,
      action: `Update comment in ${site.filePath} line ${site.line}`,
      filePath: site.filePath,
      line: site.line,
      detail: `Update comment reference to "${symbolName}". Context: ${site.context.trim()}`,
      automated: true,
      risk: 'low',
    });
  }

  // String-literal sites — manual
  for (const site of stringLitSites) {
    steps.push({
      order: 0,
      action: `Manually update string literal in ${site.filePath} line ${site.line}`,
      filePath: site.filePath,
      line: site.line,
      detail:
        `String literal "${symbolName}" requires manual judgment — ` +
        `a text rename will not fix this. Context: ${site.context.trim()}`,
      automated: false,
      risk: 'medium',
    });
  }

  // Declaration rename — always last
  steps.push({
    order: 0,
    action: `Rename declaration in ${symbolFilePath}`,
    filePath: symbolFilePath,
    detail: `Rename the "${symbolName}" declaration to "${newName}" in its definition file.`,
    automated: true,
    risk: 'low',
  });

  const totalSites = renameData.affectedSites.length;
  const callCount = callSites.length;
  const importCount = importSites.length;
  const breakdown: string[] = [];
  if (callCount > 0) breakdown.push(`${callCount} call site${callCount !== 1 ? 's' : ''}`);
  if (importCount > 0) breakdown.push(`${importCount} import${importCount !== 1 ? 's' : ''}`);

  const summary =
    `Rename "${symbolName}" → "${newName}" across ${renameData.affectedFileCount} file${renameData.affectedFileCount !== 1 ? 's' : ''}. ` +
    `Update ${totalSites} reference${totalSites !== 1 ? 's' : ''}` +
    (breakdown.length > 0 ? ` (${breakdown.join(', ')})` : '') +
    '. Rename the declaration last.';

  return { steps, warnings, summary };
}

async function planDeleteSymbol(
  repoId: string,
  symbolId: string,
  symbolName: string,
  symbolFilePath: string,
): Promise<{ steps: RefactoringStep[]; warnings: string[]; summary: string }> {
  const warnings: string[] = [];

  const deleteResult = await checkDeleteSafeHandler({ repoId, symbolId });
  const deleteData = parseResult<CheckDeleteSafeResult>(deleteResult);

  if (!deleteData) {
    return {
      steps: [],
      warnings: ['check_delete_safe returned an error — cannot generate delete plan.'],
      summary: `Cannot plan deletion of "${symbolName}": safety check failed.`,
    };
  }

  const steps: RefactoringStep[] = [];

  if (deleteData.isExported) {
    warnings.push(
      `"${symbolName}" is exported and may be consumed by external npm packages. ` +
      'Verify there are no external consumers before deleting.',
    );
  }

  if (deleteData.isEntryPoint) {
    warnings.push(
      `"${symbolName}" appears to be an entry point (route handler, main export, or framework default). ` +
      'Deleting it may break application startup or routing.',
    );
  }

  // Sort live-reference risks by file path for deterministic ordering
  const liveRefs = deleteData.risks
    .filter((r) => r.kind === 'live-reference')
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

  const testSubjectRisks = deleteData.risks.filter((r) => r.kind === 'test-subject');

  // Steps to remove each live reference first
  for (const ref of liveRefs) {
    steps.push({
      order: 0,
      action: `Remove reference to "${symbolName}" in ${ref.filePath}${ref.line != null ? ` line ${ref.line}` : ''}`,
      filePath: ref.filePath,
      line: ref.line,
      detail: ref.detail,
      automated: false,
      risk: 'medium',
    });
  }

  // Test references — inform but don't block
  for (const testRef of testSubjectRisks) {
    steps.push({
      order: 0,
      action: `Remove test reference to "${symbolName}" in ${testRef.filePath}${testRef.line != null ? ` line ${testRef.line}` : ''}`,
      filePath: testRef.filePath,
      line: testRef.line,
      detail: testRef.detail,
      automated: false,
      risk: 'low',
    });
  }

  // Deletion step — always last
  steps.push({
    order: 0,
    action: `Delete "${symbolName}" declaration in ${symbolFilePath}`,
    filePath: symbolFilePath,
    detail:
      `Remove the "${symbolName}" symbol from ${symbolFilePath}. ` +
      'Ensure all references above have been cleaned up first.',
    automated: false,
    risk: 'high',
  });

  const refCount = deleteData.liveReferenceCount;
  const safeWord = deleteData.safe ? 'Safe' : 'Unsafe';
  const summary =
    `${safeWord} to delete "${symbolName}". ` +
    (refCount > 0
      ? `${refCount} live reference${refCount !== 1 ? 's' : ''} must be removed first. `
      : 'No live references. ') +
    (testSubjectRisks.length > 0
      ? `${testSubjectRisks.length} test reference${testSubjectRisks.length !== 1 ? 's' : ''} will also need updating. `
      : '') +
    'Delete declaration last.';

  return { steps, warnings, summary };
}

async function planBreakCycle(
  repoId: string,
  filePath: string,
): Promise<{ steps: RefactoringStep[]; warnings: string[]; summary: string }> {
  const warnings: string[] = [];

  const cyclesResult = await findCyclesHandler({ repoId, filePath, maxCycles: 5 });
  const cyclesData = parseResult<FindCyclesResult>(cyclesResult);

  if (!cyclesData || cyclesData.cycles.length === 0) {
    return {
      steps: [],
      warnings: [`No import cycles found involving "${filePath}".`],
      summary: `No import cycles detected for "${filePath}". No refactoring needed.`,
    };
  }

  if (cyclesData.totalFound > cyclesData.cycles.length) {
    warnings.push(
      `${cyclesData.totalFound} cycles found; showing first ${cyclesData.cycles.length}. ` +
      'Run find_cycles without filePath to see all.',
    );
  }

  // Also get coupling data to identify weakest edge in each cycle
  const couplingResult = await getCouplingMapHandler({ repoId });
  const couplingData = parseResult<GetCouplingMapResult>(couplingResult);

  const couplingMap = new Map<string, FileCoupling>();
  if (couplingData) {
    for (const fc of couplingData.files) {
      couplingMap.set(fc.filePath, fc);
    }
  }

  const steps: RefactoringStep[] = [];

  for (const cycle of cyclesData.cycles) {
    // Find the weakest edge: the file in the cycle with the fewest afferent
    // (incoming) deps — it has the least impact if modified.
    let weakestFile = cycle.files[0]!;
    let lowestAfferent = Infinity;
    for (const f of cycle.files) {
      const fc = couplingMap.get(f);
      const afferent = fc ? fc.afferentCoupling : 0;
      if (afferent < lowestAfferent) {
        lowestAfferent = afferent;
        weakestFile = f;
      }
    }

    const cycleStr = cycle.files.join(' → ');

    steps.push({
      order: 0,
      action: `Create a shared module to break the cycle: ${cycleStr}`,
      filePath: weakestFile,
      detail:
        `The weakest edge in this cycle is on "${weakestFile}" ` +
        `(${lowestAfferent} afferent coupling). ` +
        `Extract the shared dependency from "${weakestFile}" into a new lower-level module ` +
        'that both sides of the cycle can import without creating a cycle.',
      automated: false,
      risk: 'medium',
    });

    steps.push({
      order: 0,
      action: `Update imports in cycle members to use the new shared module`,
      filePath: weakestFile,
      detail:
        `After extracting to the shared module, update ${cycle.files.length} files ` +
        `in the cycle (${cycleStr}) to import from the new location instead.`,
      automated: true,
      risk: 'low',
    });
  }

  const cycleWord = cyclesData.cycles.length === 1 ? 'cycle' : 'cycles';
  const summary =
    `Break ${cyclesData.cycles.length} import ${cycleWord} involving "${filePath}". ` +
    'Extract shared types/interfaces into lower-level modules that all cycle members can import. ' +
    'Steps require design judgment to decide which symbols to extract.';

  return { steps, warnings, summary };
}

async function planExtractModule(
  repoId: string,
  filePath: string,
  newFilePath: string,
): Promise<{ steps: RefactoringStep[]; warnings: string[]; summary: string }> {
  const warnings: string[] = [];

  const moveResult = await checkMoveSafeHandler({ repoId, filePath, newFilePath });
  const moveData = parseResult<CheckMoveSafeResult>(moveResult);

  if (!moveData) {
    return {
      steps: [],
      warnings: ['check_move_safe returned an error — cannot generate extract-module plan.'],
      summary: `Cannot plan move of "${filePath}" to "${newFilePath}": safety check failed.`,
    };
  }

  if (moveData.wouldIntroduceCycles) {
    warnings.push(
      `Moving "${filePath}" to "${newFilePath}" would introduce ${moveData.newCycles.length} ` +
      'import cycle(s). Review the cycle details before proceeding.',
    );
  }

  const steps: RefactoringStep[] = [];

  // Import update steps first (show the full edit list before the physical move)
  for (const update of moveData.importUpdates) {
    steps.push({
      order: 0,
      action: `Update import in ${update.importerFilePath} line ${update.line}`,
      filePath: update.importerFilePath,
      line: update.line,
      detail:
        `Change import path from "${update.currentImportPath}" to "${update.newImportPath}".`,
      automated: true,
      risk: 'low',
    });
  }

  // Physical file move step — last
  steps.push({
    order: 0,
    action: `Move file from "${filePath}" to "${newFilePath}"`,
    filePath,
    detail:
      `Physically move the file and update any build-tool references ` +
      `(tsconfig paths, barrel files, package.json exports). ` +
      `All ${moveData.importUpdates.length} import statement(s) above must be updated.`,
    automated: true,
    risk: moveData.wouldIntroduceCycles ? 'high' : 'medium',
  });

  const count = moveData.importUpdates.length;
  const summary =
    `Move "${filePath}" to "${newFilePath}". ` +
    `${count} import statement${count !== 1 ? 's' : ''} across ` +
    `${new Set(moveData.importUpdates.map((u) => u.importerFilePath)).size} file(s) need updating.` +
    (moveData.wouldIntroduceCycles
      ? ` WARNING: move would introduce ${moveData.newCycles.length} import cycle(s).`
      : ' No cycles introduced.');

  return { steps, warnings, summary };
}

async function planReduceCoupling(
  repoId: string,
  filePath: string,
): Promise<{ steps: RefactoringStep[]; warnings: string[]; summary: string }> {
  const warnings: string[] = [];

  const couplingResult = await getCouplingMapHandler({ repoId, filePath });
  const couplingData = parseResult<GetCouplingMapResult>(couplingResult);

  if (!couplingData || couplingData.files.length === 0) {
    return {
      steps: [],
      warnings: [`No coupling data found for "${filePath}".`],
      summary: `No coupling data available for "${filePath}".`,
    };
  }

  const fc = couplingData.files[0]!;
  const totalCoupling = fc.efferentCoupling + fc.afferentCoupling;

  const steps: RefactoringStep[] = [];

  if (totalCoupling < 3) {
    warnings.push(
      `"${filePath}" has low total coupling (${totalCoupling}). ` +
      'Splitting it may not yield significant benefits.',
    );
  }

  // Suggest extracting the most-imported dependency groups
  const topEfferentDeps = fc.efferentDeps.slice(0, 3);
  if (topEfferentDeps.length > 0) {
    for (const dep of topEfferentDeps) {
      steps.push({
        order: 0,
        action: `Evaluate extracting functionality related to "${dep}" into a dedicated module`,
        filePath,
        detail:
          `"${filePath}" imports from "${dep}". If these imports represent a cohesive concern, ` +
          'consider extracting related symbols into a separate module to reduce coupling. ' +
          `Current efferent coupling: ${fc.efferentCoupling}.`,
        automated: false,
        risk: 'medium',
      });
    }
  }

  // Suggest addressing high afferent coupling (many dependents)
  if (fc.afferentCoupling >= 3) {
    steps.push({
      order: 0,
      action: `Split "${filePath}" to reduce its ${fc.afferentCoupling} afferent dependencies`,
      filePath,
      detail:
        `${fc.afferentCoupling} files depend on "${filePath}". Split it into focused modules ` +
        '(e.g., separate public API from implementation details) so consumers only import what they need. ' +
        `Instability score: ${fc.instability.toFixed(2)} (0=stable hub, 1=leaf).`,
      automated: false,
      risk: 'medium',
    });
  }

  if (steps.length === 0) {
    steps.push({
      order: 0,
      action: `Review "${filePath}" for extraction opportunities`,
      filePath,
      detail:
        `Total coupling: ${totalCoupling} (efferent: ${fc.efferentCoupling}, afferent: ${fc.afferentCoupling}). ` +
        'No strong coupling signals detected. Review manually for logical groupings.',
      automated: false,
      risk: 'low',
    });
  }

  const summary =
    `Reduce coupling in "${filePath}" (efferent: ${fc.efferentCoupling}, afferent: ${fc.afferentCoupling}, ` +
    `instability: ${fc.instability.toFixed(2)}). ` +
    'Extract cohesive groups of functionality into focused modules.';

  return { steps, warnings, summary };
}

async function planGeneral(
  repoId: string,
  filePath?: string,
  symbolId?: string,
  contextHint?: string,
): Promise<{ steps: RefactoringStep[]; warnings: string[]; summary: string }> {
  const warnings: string[] = [];
  const steps: RefactoringStep[] = [];

  // Run antipattern detection
  const antipatternsResult = await detectAntipatternsHandler({ repoId });
  const antipatternsData = parseResult<DetectAntipatternsResult>(antipatternsResult);

  // Run quality metrics (scoped to filePath directory if provided)
  const qualityResult = await getQualityMetricsHandler({
    repoId,
    scope: filePath ?? undefined,
    limit: 5,
  });
  const qualityData = parseResult<GetQualityMetricsResult>(qualityResult);

  const targetFile = filePath ?? '';

  // Filter antipattern findings to the target file (or all if no filePath)
  const relevantFindings = antipatternsData
    ? antipatternsData.findings.filter((f) => !targetFile || f.filePath.includes(targetFile))
    : [];

  // Sort findings: errors before warnings, then alphabetically
  relevantFindings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return a.filePath.localeCompare(b.filePath);
  });

  // Add steps for top antipatterns (up to 2)
  for (const finding of relevantFindings.slice(0, 2)) {
    steps.push({
      order: 0,
      action: `Fix "${finding.check}" in ${finding.filePath}`,
      filePath: finding.filePath,
      detail: `${finding.description} ${finding.suggestion}`,
      automated: false,
      risk: finding.severity === 'error' ? 'high' : 'medium',
    });
  }

  // Add steps for worst quality offenders (up to 2, from the target file if scoped)
  if (qualityData) {
    const worstOffenders = targetFile
      ? qualityData.worstOffenders.filter((s) => s.filePath.includes(targetFile))
      : qualityData.worstOffenders;

    for (const sym of worstOffenders.slice(0, 2)) {
      if (sym.riskLevel === 'good') continue;
      steps.push({
        order: 0,
        action: `Reduce complexity of "${sym.name}" in ${sym.filePath}`,
        filePath: sym.filePath,
        detail:
          `"${sym.name}" has cyclomatic complexity ${sym.cyclomaticComplexity}, ` +
          `${sym.lineCount} lines, and quality score ${sym.qualityScore}/100 (${sym.riskLevel}). ` +
          'Consider splitting into smaller focused functions.',
        automated: false,
        risk: sym.riskLevel === 'critical' ? 'high' : 'medium',
      });
    }
  }

  if (steps.length === 0) {
    warnings.push('No quality issues or antipatterns found for the target. No refactoring needed.');
  }

  const scope = targetFile ? `"${targetFile}"` : 'the repo';
  const hint = contextHint ? ` Context: ${contextHint}.` : '';
  const summary =
    `General refactoring analysis for ${scope}. ` +
    `${steps.length} improvement${steps.length !== 1 ? 's' : ''} identified.${hint}`;

  return { steps, warnings, summary };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handler(args: {
  repoId: string;
  symbolId?: string;
  filePath?: string;
  goal: RefactoringGoal;
  newName?: string;
  newFilePath?: string;
  contextHint?: string;
}): Promise<CallToolResult> {
  const t0 = Date.now();
  const { repoId, symbolId, goal, newName, newFilePath, contextHint } = args;
  let { filePath } = args;

  // ── Validate repo ──────────────────────────────────────────────────────────

  const db = openDatabase(repoId);
  let symbolName = '';
  let symbolFilePath = '';

  try {
    const repo = getRepo(db, repoId);
    if (!repo) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Repo "${repoId}" not found. Run index_folder first.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // ── Resolve symbol → filePath ────────────────────────────────────────────

    if (symbolId) {
      const symbol = getSymbolById(db, repoId, symbolId);
      if (!symbol) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Symbol "${symbolId}" not found in repo "${repoId}".`,
              }),
            },
          ],
          isError: true,
        };
      }
      symbolName = symbol.name;
      symbolFilePath = symbol.filePath;
      // Derive filePath from symbol when not explicitly provided
      if (!filePath) filePath = symbol.filePath;
    }
  } finally {
    db.close();
  }

  // ── Goal-specific validation ───────────────────────────────────────────────

  if (goal === 'rename-symbol') {
    if (!symbolId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'rename-symbol requires symbolId.' }) }],
        isError: true,
      };
    }
    if (!newName) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'rename-symbol requires newName.' }) }],
        isError: true,
      };
    }
  }

  if (goal === 'delete-symbol' && !symbolId) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'delete-symbol requires symbolId.' }) }],
      isError: true,
    };
  }

  if ((goal === 'break-cycle' || goal === 'reduce-coupling') && !filePath) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: `${goal} requires filePath or a symbolId whose file will be used as scope.`,
          }),
        },
      ],
      isError: true,
    };
  }

  if (goal === 'extract-module') {
    if (!filePath) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'extract-module requires filePath.' }) }],
        isError: true,
      };
    }
    if (!newFilePath) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'extract-module requires newFilePath.' }) }],
        isError: true,
      };
    }
  }

  // ── Dispatch to goal handler ───────────────────────────────────────────────

  let goalResult: { steps: RefactoringStep[]; warnings: string[]; summary: string };

  switch (goal) {
    case 'rename-symbol':
      goalResult = await planRenameSymbol(repoId, symbolId!, symbolName, symbolFilePath, newName!);
      break;
    case 'delete-symbol':
      goalResult = await planDeleteSymbol(repoId, symbolId!, symbolName, symbolFilePath);
      break;
    case 'break-cycle':
      goalResult = await planBreakCycle(repoId, filePath!);
      break;
    case 'extract-module':
      goalResult = await planExtractModule(repoId, filePath!, newFilePath!);
      break;
    case 'reduce-coupling':
      goalResult = await planReduceCoupling(repoId, filePath!);
      break;
    case 'general':
      goalResult = await planGeneral(repoId, filePath, symbolId, contextHint);
      break;
  }

  const steps = numberSteps(goalResult.steps);
  const estimatedRisk = aggregateRisk(steps);

  const responseText = JSON.stringify({ steps, warnings: goalResult.warnings });
  const output: PlanRefactoringOutput = {
    goal,
    summary: goalResult.summary,
    steps,
    totalSteps: steps.length,
    estimatedRisk,
    warnings: goalResult.warnings,
    _tokenEstimate: Math.ceil(responseText.length / 4),
    _meta: buildMeta({ timingMs: Date.now() - t0 }),
  };

  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
}
