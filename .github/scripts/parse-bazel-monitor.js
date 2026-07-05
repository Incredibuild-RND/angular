'use strict';

const fs = require('fs');
const zlib = require('zlib');

const SENSITIVE_KEYS = /^(BUILD_USER|BUILD_HOST|USER|HOSTNAME|HOME|GIT_.*EMAIL|.*PASSWORD|.*TOKEN|.*SECRET|.*KEY)$/i;
const SENSITIVE_FLAGS = /^(--(?:remote_cache|remote_executor|remote_downloader|remote_proxy|bes_backend|bes_results_url|(?:remote|bes)(?:_cache|_exec|_downloader)?_header))=.+$/;
const EXEC_CAP = 2500;

function redactPath(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\/(Users|home)\/[^/\s]+/g, '/$1/<redacted>')
    .replace(/\/_bazel_[^/\s]+/g, '/_bazel_<redacted>');
}

function redactFlag(flag) {
  const match = SENSITIVE_FLAGS.exec(flag);
  return match ? `${match[1]}=<redacted>` : flag;
}

function toInt(value) {
  return value == null ? 0 : parseInt(value, 10) || 0;
}

function timeMs(value) {
  if (value == null) return 0;
  const match = /^([0-9.]+)\s*(ms|s|us|ns|m|h)?$/.exec(String(value).trim());
  if (!match) return 0;
  const amount = parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;
  switch (match[2]) {
    case 'ms': return +amount.toFixed(3);
    case 'us': return +(amount / 1000).toFixed(3);
    case 'ns': return +(amount / 1000000).toFixed(3);
    case 'm': return +(amount * 60000).toFixed(3);
    case 'h': return +(amount * 3600000).toFixed(3);
    case 's':
    default:
      return +(amount * 1000).toFixed(3);
  }
}

function parseBep(text) {
  const meta = {
    invocationId: '',
    command: '',
    patterns: [],
    bazelVersion: '',
    cwd: '',
    configMnemonic: '',
    startedMs: 0,
    finishedMs: 0,
    durationMs: 0,
    success: null,
    exit: '',
    commit: '',
    branch: '',
    repo: '',
    role: '',
    cpu: '',
    platform: '',
    mode: '',
    failureDetail: null,
    failedAction: null,
  };
  const metrics = {
    targetsConfigured: 0,
    actionsExecuted: 0,
    cpuTimeMs: 0,
    wallTimeMs: 0,
    analysisMs: 0,
    executionMs: 0,
    sourceArtifacts: { count: 0, bytes: 0 },
    outputArtifacts: { count: 0, bytes: 0 },
    outputFromCache: { count: 0, bytes: 0 },
    cacheHitRate: 0,
    actionsByMnemonic: [],
  };
  const targets = [];
  const tests = [];
  const status = [];
  const options = [];
  let logText = '';
  let logTruncated = false;
  const logCap = 1024 * 1024;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const idKind = event.id ? Object.keys(event.id)[0] : '';

    if (event.started) {
      meta.invocationId = event.started.uuid || '';
      meta.command = event.started.command || '';
      meta.bazelVersion = event.started.buildToolVersion || '';
      meta.cwd = redactPath(event.started.workingDirectory || event.started.workspaceDirectory || '');
      meta.startedMs = toInt(event.started.startTimeMillis) || (event.started.startTime ? Date.parse(event.started.startTime) : 0);
    } else if (idKind === 'pattern' && event.id.pattern) {
      meta.patterns = event.id.pattern.pattern || [];
    } else if (event.configuration) {
      const cfg = event.configuration;
      meta.configMnemonic = cfg.mnemonic || meta.configMnemonic;
      meta.platform = cfg.platformName || meta.platform;
      meta.cpu = cfg.cpu || meta.cpu;
      if (cfg.makeVariable) {
        meta.mode = cfg.makeVariable.COMPILATION_MODE || meta.mode;
        meta.cpu = meta.cpu || cfg.makeVariable.TARGET_CPU || '';
      }
    } else if (event.optionsParsed) {
      const seen = new Set();
      const flags = []
        .concat(event.optionsParsed.explicitCmdLine || [])
        .concat(event.optionsParsed.cmdLine || []);
      for (const flag of flags) {
        const redacted = redactFlag(redactPath(String(flag)));
        if (seen.has(redacted)) continue;
        seen.add(redacted);
        options.push(redacted);
      }
    } else if (event.buildMetadata && event.buildMetadata.metadata) {
      const metadata = event.buildMetadata.metadata;
      meta.commit = metadata.COMMIT_SHA || meta.commit;
      meta.branch = metadata.BRANCH_NAME || meta.branch;
      meta.repo = redactPath(metadata.REPO_URL || meta.repo);
      meta.role = metadata.ROLE || meta.role;
    } else if (event.workspaceStatus && event.workspaceStatus.item) {
      for (const item of event.workspaceStatus.item) {
        if (SENSITIVE_KEYS.test(item.key)) continue;
        const value = redactPath(item.value || '');
        status.push({ key: item.key, value });
        if (/^(BUILD_SCM_REVISION|STABLE_BUILD_SCM_REVISION|COMMIT_SHA|GIT_COMMIT)$/i.test(item.key) && !meta.commit) meta.commit = value;
        if (/^(BUILD_SCM_BRANCH|STABLE_BUILD_SCM_BRANCH|STABLE_GIT_BRANCH|GIT_BRANCH)$/i.test(item.key) && !meta.branch) meta.branch = value;
        if (/^(REPO_URL|STABLE_REPO_URL|GIT_URL)$/i.test(item.key) && !meta.repo) meta.repo = value;
        if (/^(ROLE|BUILD_ROLE)$/i.test(item.key) && !meta.role) meta.role = value;
      }
    } else if (idKind === 'targetCompleted' && event.completed) {
      const label = event.id.targetCompleted.label;
      const success = !!event.completed.success;
      targets.push({ label, success, status: success ? 'BUILT' : 'FAILED', outputs: ((event.completed.outputGroup || [])[0] || {}).name || '', durMs: 0 });
    } else if (idKind === 'testSummary' && event.testSummary) {
      const summary = event.testSummary;
      tests.push({
        label: event.id.testSummary.label,
        status: summary.overallStatus || '',
        runs: toInt(summary.totalRunCount),
        durationMs: toInt(summary.totalRunDurationMillis) || timeMs(summary.totalRunDuration),
        passed: (summary.passed || []).length,
        failed: (summary.failed || []).length,
      });
    } else if (event.action && event.action.success !== true && !meta.failedAction) {
      const action = event.action;
      meta.failedAction = {
        mnemonic: action.type || action.mnemonic || '',
        label: (event.id && event.id.actionCompleted ? event.id.actionCompleted.label : '') || '',
        exitCode: toInt(action.exitCode),
        stdout: redactPath((action.stdout && (action.stdout.uri || action.stdout.name)) || ''),
        stderr: redactPath((action.stderr && (action.stderr.uri || action.stderr.name)) || ''),
      };
    } else if (event.progress && !logTruncated) {
      const chunk = (event.progress.stdout || '') + (event.progress.stderr || '');
      if (chunk) {
        logText += chunk;
        if (logText.length > logCap) {
          logText = logText.slice(-logCap);
          logTruncated = true;
        }
      }
    } else if (event.finished) {
      meta.finishedMs = toInt(event.finished.finishTimeMillis) || (event.finished.finishTime ? Date.parse(event.finished.finishTime) : 0);
      meta.success = event.finished.exitCode ? (event.finished.exitCode.code == null || toInt(event.finished.exitCode.code) === 0) : !!event.finished.overallSuccess;
      meta.exit = (event.finished.exitCode || {}).name || '';
      if (event.finished.exitCode && event.finished.exitCode.code != null) meta.exitCode = toInt(event.finished.exitCode.code);
      if (event.finished.failureDetail && !meta.failureDetail) {
        const detail = event.finished.failureDetail;
        meta.failureDetail = { reason: detail.message || '', category: Object.keys(detail).find((key) => key !== 'message') || '' };
      }
    } else if (event.buildMetrics) {
      const buildMetrics = event.buildMetrics;
      const artifacts = buildMetrics.artifactMetrics || {};
      const timing = buildMetrics.timingMetrics || {};
      const actionSummary = buildMetrics.actionSummary || {};
      const seen = artifacts.outputArtifactsSeen || {};
      const cached = artifacts.outputArtifactsFromActionCache || {};
      const seenCount = toInt(seen.count);
      const cachedCount = toInt(cached.count);
      metrics.targetsConfigured = toInt((buildMetrics.targetMetrics || {}).targetsConfigured);
      metrics.actionsExecuted = toInt(actionSummary.actionsExecuted);
      metrics.cpuTimeMs = toInt(timing.cpuTimeInMs);
      metrics.wallTimeMs = toInt(timing.wallTimeInMs);
      metrics.analysisMs = toInt(timing.analysisPhaseTimeInMs);
      metrics.executionMs = toInt(timing.executionPhaseTimeInMs);
      metrics.sourceArtifacts = { count: toInt((artifacts.sourceArtifactsRead || {}).count), bytes: toInt((artifacts.sourceArtifactsRead || {}).sizeInBytes) };
      metrics.outputArtifacts = { count: seenCount, bytes: toInt(seen.sizeInBytes) };
      metrics.outputFromCache = { count: cachedCount, bytes: toInt(cached.sizeInBytes) };
      metrics.cacheHitRate = seenCount ? +(100 * cachedCount / seenCount).toFixed(2) : 0;
      metrics.actionsByMnemonic = (actionSummary.actionData || []).map((action) => ({
        mnemonic: action.mnemonic || '',
        count: toInt(action.actionsExecuted),
        firstStartedMs: toInt(action.firstStartedMs),
        lastEndedMs: toInt(action.lastEndedMs),
        totalMs: 0,
      })).sort((a, b) => b.count - a.count);
    }
  }

  if (meta.startedMs && meta.finishedMs) meta.durationMs = meta.finishedMs - meta.startedMs;
  for (const test of tests) {
    const target = targets.find((candidate) => candidate.label === test.label);
    if (target) target.durMs = test.durationMs;
  }
  targets.sort((a, b) => (a.status === b.status ? b.durMs - a.durMs : a.status.localeCompare(b.status)));

  return { meta, metrics, targets, tests, status, logs: { text: redactPath(logText), truncated: logTruncated }, options };
}

function parseProfile(profilePath) {
  if (!profilePath || !fs.existsSync(profilePath)) {
    return { totalMs: 0, startTsMs: 0, threads: [], spans: [], phases: [], wallPhases: [], criticalPath: [], counters: [], durByTarget: {}, durByMnemonic: {} };
  }
  try {
    const buffer = fs.readFileSync(profilePath);
    const json = JSON.parse(buffer[0] === 0x1f ? zlib.gunzipSync(buffer) : buffer);
    const traceEvents = json.traceEvents || [];
    let minTs = Infinity;
    let maxEnd = 0;
    let spanCount = 0;
    for (const event of traceEvents) {
      if (event.ph !== 'X' || !(event.dur > 0)) continue;
      const startMs = event.ts / 1000;
      const endMs = startMs + event.dur / 1000;
      minTs = Math.min(minTs, startMs);
      maxEnd = Math.max(maxEnd, endMs);
      spanCount++;
    }
    if (!Number.isFinite(minTs)) minTs = 0;
    return {
      totalMs: +(maxEnd - minTs).toFixed(1),
      startTsMs: +minTs.toFixed(3),
      threads: [],
      spans: [],
      phases: [{ name: 'profile spans', durMs: spanCount }],
      wallPhases: [],
      criticalPath: [],
      counters: [],
      durByTarget: {},
      durByMnemonic: {},
    };
  } catch {
    return { totalMs: 0, startTsMs: 0, threads: [], spans: [], phases: [], wallPhases: [], criticalPath: [], counters: [], durByTarget: {}, durByMnemonic: {} };
  }
}

function* execObjects(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        yield text.slice(start, index + 1);
        start = -1;
      }
    }
  }
}

function parseExecLog(execLogPath) {
  if (!execLogPath || !fs.existsSync(execLogPath)) return { executions: [], scorecard: null };

  const executions = [];
  const byRunner = {};
  const byMnemonic = {};
  let totalActions = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let remoteCacheHits = 0;
  let totalInputBytes = 0;
  let totalFetchMs = 0;

  for (const slice of execObjects(fs.readFileSync(execLogPath, 'utf8'))) {
    let record;
    try {
      record = JSON.parse(slice);
    } catch {
      continue;
    }
    if (record.mnemonic == null && record.targetLabel == null) continue;

    const metrics = record.metrics || {};
    const runner = record.runner || '';
    const mnemonic = record.mnemonic || '';
    const cacheHit = !!record.cacheHit;
    const inputBytes = toInt(metrics.inputBytes);
    const fetchMs = timeMs(metrics.fetchTime);
    const totalMs = timeMs(metrics.totalTime);

    totalActions++;
    if (cacheHit) cacheHits++;
    else cacheMisses++;
    if (cacheHit && /remote/i.test(runner)) remoteCacheHits++;
    totalInputBytes += inputBytes;
    totalFetchMs += fetchMs;
    byRunner[runner] = (byRunner[runner] || 0) + 1;

    const row = byMnemonic[mnemonic] || (byMnemonic[mnemonic] = { mnemonic, count: 0, hits: 0, misses: 0, totalMs: 0, inputBytes: 0 });
    row.count++;
    if (cacheHit) row.hits++;
    else row.misses++;
    row.totalMs += totalMs;
    row.inputBytes += inputBytes;

    if (executions.length < EXEC_CAP) {
      const digest = record.digest || {};
      executions.push({
        target: redactPath(record.targetLabel || ''),
        mnemonic,
        runner,
        cacheHit,
        remoteCacheable: !!record.remoteCacheable,
        exitCode: toInt(record.exitCode),
        digestHash: String(digest.hash || '').slice(0, 12),
        sizeBytes: toInt(digest.sizeBytes),
        totalMs,
        fetchMs,
        execMs: timeMs(metrics.executionWallTime),
        uploadMs: timeMs(metrics.uploadTime),
        queueMs: timeMs(metrics.queueTime),
        setupMs: timeMs(metrics.setupTime),
        inputBytes,
        inputFiles: toInt(metrics.inputFiles),
      });
    }
  }

  return {
    executions,
    scorecard: {
      totalActions,
      cacheHits,
      cacheMisses,
      hitRate: totalActions ? +(100 * cacheHits / totalActions).toFixed(2) : 0,
      byRunner: Object.entries(byRunner).map(([runner, count]) => ({ runner, count })).sort((a, b) => b.count - a.count),
      byMnemonic: Object.values(byMnemonic).map((row) => ({
        mnemonic: row.mnemonic,
        count: row.count,
        hits: row.hits,
        misses: row.misses,
        totalMs: +row.totalMs.toFixed(1),
        inputBytes: row.inputBytes,
      })).sort((a, b) => b.count - a.count),
      totalInputBytes,
      totalFetchMs: +totalFetchMs.toFixed(1),
      remoteCacheHits,
    },
  };
}

function parse(bepPath, profilePath, execLogPath) {
  const bep = parseBep(fs.readFileSync(bepPath, 'utf8'));
  const timeline = parseProfile(profilePath);
  const exec = parseExecLog(execLogPath);
  return Object.assign({ tool: 'bazel', real: true }, bep, { timeline, executions: exec.executions, scorecard: exec.scorecard });
}

if (require.main === module) {
  const [bepPath, profilePath, outPath, execLogPath] = process.argv.slice(2);
  if (!bepPath) {
    console.error('usage: node .github/scripts/parse-bazel-monitor.js <bep.ndjson> <profile.json.gz> [out.json] [exec.json]');
    process.exit(1);
  }
  const dataset = parse(bepPath, profilePath, execLogPath);
  const json = JSON.stringify(dataset);
  if (outPath) fs.writeFileSync(outPath, json);
  else process.stdout.write(json);
  console.error(`[parse] ${dataset.meta.command} ${dataset.meta.patterns.join(' ')} | bazel ${dataset.meta.bazelVersion} | ${dataset.meta.durationMs}ms | targets=${dataset.targets.length} tests=${dataset.tests.length}`);
}
