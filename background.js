const DEFAULT_REPORTS = [];
const LEGACY_DEFAULT_REPORT_URL = "https://ntba.gte666.com/#/dashboard/11500_132528";

const DEFAULT_CREDENTIALS = {
  account: "chenjianfeng",
  password: "tba@Jeff666"
};

const DEFAULT_PARSE_SECTIONS = [
  {
    id: "section-business",
    title: "经营数据"
  },
  {
    id: "section-core",
    title: "核心指标"
  }
];

const DEFAULT_OUTPUT_TEMPLATE = `- [code]
\t- [t1]解析结果是:[t1,h1] [t1,r-1,c1]，[t1,h6] [t1,r-1,c6]
\t- [t2]解析结果是:[t2,h1] [t2,r-1,c1]，[t2,h2] [t2,r-1,c2]，[t2,h3] [t2,r-1,c3]，[t2,h4] [t2,r-1,c4]`;

const CONTENT_SCRIPT_FILE = "content.js";
const TAB_LOAD_TIMEOUT_MS = 60000;
const SNIFF_TIMEOUT_MS = 95000;

let activeRun = {
  running: false,
  shouldStop: false,
  currentTabId: null,
  statuses: {},
  log: ""
};

chrome.runtime.onInstalled.addListener(() => {
  initializeDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  initializeDefaults();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: messageFromError(error)
      });
    });
  return true;
});

async function initializeDefaults() {
  const stored = await storageGet(["reports", "credentials", "parseSections", "outputTemplate"]);
  const next = {};

  if (!Array.isArray(stored.reports) || isLegacyDefaultReports(stored.reports)) {
    next.reports = DEFAULT_REPORTS;
  }

  if (!stored.credentials) {
    next.credentials = DEFAULT_CREDENTIALS;
  }

  if (!Array.isArray(stored.parseSections) || !stored.parseSections.length) {
    next.parseSections = DEFAULT_PARSE_SECTIONS;
  }

  if (!stored.outputTemplate) {
    next.outputTemplate = DEFAULT_OUTPUT_TEMPLATE;
  }

  if (Object.keys(next).length) {
    await storageSet(next);
  }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "START_RUN":
      return startRun(message.payload || {});
    case "STOP_RUN":
      return stopRun();
    case "GET_STATE":
      return getState();
    case "CONTENT_LOG":
      await appendLog(formatContentLog(sender.tab, message.payload));
      return {
        ok: true
      };
    default:
      return {
        ok: false,
        error: "未知消息类型"
      };
  }
}

async function startRun(payload) {
  if (activeRun.running) {
    return {
      ok: false,
      error: "已有任务正在运行"
    };
  }

  const reports = normalizeReports(payload.reports);
  const credentials = normalizeCredentials(payload.credentials);
  const parseSections = normalizeParseSections(payload.parseSections);
  const outputTemplate = normalizeOutputTemplate(payload.outputTemplate);
  const rowOffsets = collectRowOffsetsFromTemplate(outputTemplate);

  activeRun = {
    running: true,
    shouldStop: false,
    currentTabId: null,
    statuses: Object.fromEntries(
      reports.map((report) => [
        report.id,
        {
          status: "待处理",
          detail: ""
        }
      ])
    ),
    log: ""
  };

  await storageSet({
    reports,
    credentials,
    parseSections,
    outputTemplate,
    runLog: "",
    runtimeState: publicRuntimeState()
  });

  await appendLog(`任务开始，共 ${reports.length} 个网址`);

  void runQueue(reports, credentials, parseSections, outputTemplate, rowOffsets).catch(async (error) => {
    await appendLog(`任务异常中断：${messageFromError(error)}`);
    activeRun.running = false;
    activeRun.currentTabId = null;
    await persistRuntimeState();
  });

  return {
    ok: true
  };
}

async function stopRun() {
  activeRun.shouldStop = true;
  if (activeRun.currentTabId) {
    await sendTabMessage(activeRun.currentTabId, {
      type: "STOP_SNIFF"
    }).catch(() => null);
  }
  await appendLog("已收到停止指令，当前页面会尽快结束");
  await persistRuntimeState();
  return {
    ok: true
  };
}

async function getState() {
  const stored = await storageGet(["runtimeState", "runLog"]);
  return {
    ok: true,
    runtimeState: stored.runtimeState || publicRuntimeState(),
    runLog: stored.runLog || activeRun.log || ""
  };
}

async function runQueue(reports, credentials, parseSections, outputTemplate, rowOffsets) {
  if (!reports.length) {
    await appendLog("没有可执行的网址");
  }

  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];
    let openedTabId = null;

    if (activeRun.shouldStop) {
      await setReportStatus(report.id, "已停止", "任务在打开该网址前停止");
      continue;
    }

    await setReportStatus(report.id, "打开中", report.url);
    await appendLog(`[${index + 1}/${reports.length}] 打开：${report.url}`);

    try {
      const tab = await tabsCreate({
        url: report.url,
        active: true
      });
      openedTabId = tab.id;
      activeRun.currentTabId = tab.id;
      await focusTab(tab.id, tab.windowId);

      await setReportStatus(report.id, "等待加载", report.url);
      await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);

      await setReportStatus(report.id, "解析中", report.url);
      const response = await runSniffOnTab(tab.id, {
        report,
        credentials,
        parseSections,
        rowOffsets,
        timeoutMs: SNIFF_TIMEOUT_MS
      });

      if (response?.ok) {
        const isComplete = !hasParseProblem(response.result);
        await setReportStatus(report.id, isComplete ? "完成" : "完成(有缺失)", "解析完成");
        await appendOutputBlock(formatReportResult(response.result, index, outputTemplate));
      } else {
        const errorText = response?.error || "页面脚本未返回结果";
        await setReportStatus(report.id, "失败", errorText);
        await appendOutputBlock(formatFailure(errorText, response?.result, index, outputTemplate));
      }
    } catch (error) {
      const errorText = messageFromError(error);
      await setReportStatus(report.id, "失败", errorText);
      await appendOutputBlock(formatFailure(errorText, null, index, outputTemplate));
    } finally {
      if (openedTabId) {
        await tabsRemove(openedTabId).catch((error) => appendLog(`关闭页面失败：${messageFromError(error)}`));
      }
      activeRun.currentTabId = null;
    }
  }

  activeRun.running = false;
  activeRun.currentTabId = null;
  await appendLog(activeRun.shouldStop ? "任务已停止" : "任务完成");
  await persistRuntimeState();
}

async function runSniffOnTab(tabId, payload) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (activeRun.shouldStop) {
      return {
        ok: false,
        error: "任务已停止"
      };
    }

    await ensureContentScript(tabId);

    try {
      const response = await sendTabMessage(tabId, {
        type: "RUN_SNIFF",
        payload
      });

      if (response?.needsRetry) {
        lastError = new Error(response.error || "页面发生跳转，准备重试");
        await appendLog(`页面脚本请求重试：${lastError.message}`);
        await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
        await sleep(1200);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      await appendLog(`第 ${attempt} 次解析尝试失败：${messageFromError(error)}`);
      await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS).catch(() => null);
      await sleep(1500);
    }
  }

  return {
    ok: false,
    error: `多次解析失败：${messageFromError(lastError)}`
  };
}

async function ensureContentScript(tabId) {
  try {
    await sendTabMessage(tabId, {
      type: "PING"
    });
  } catch (error) {
    await scriptingExecuteScript({
      target: {
        tabId
      },
      files: [CONTENT_SCRIPT_FILE]
    });
    await sleep(250);
  }
}

async function focusTab(tabId, windowId) {
  if (windowId) {
    await windowsUpdate(windowId, {
      focused: true
    }).catch(() => null);
  }

  await tabsUpdate(tabId, {
    active: true
  });
}

function normalizeReports(value) {
  if (isLegacyDefaultReports(value)) {
    return [];
  }

  const source = Array.isArray(value) ? value : DEFAULT_REPORTS;
  return source
    .map((report) => ({
      id: report.id || createId(),
      url: String(report.url || "").trim()
    }))
    .filter((report) => report.url);
}

function isLegacyDefaultReports(value) {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    normalizeUrlForCompare(value[0]?.url) === normalizeUrlForCompare(LEGACY_DEFAULT_REPORT_URL)
  );
}

function normalizeUrlForCompare(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    return url.href;
  } catch (error) {
    return trimmed;
  }
}

function normalizeCredentials(value) {
  return {
    account: String(value?.account || DEFAULT_CREDENTIALS.account || "").trim(),
    password: String(value?.password || DEFAULT_CREDENTIALS.password || "")
  };
}

function normalizeParseSections(value) {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_PARSE_SECTIONS;
  return source
    .map((section, index) => ({
      id: section.id || `section-${index + 1}`,
      title: String(section.title || section.name || "").trim()
    }))
    .filter((section) => section.title);
}

function normalizeOutputTemplate(value) {
  const template = String(value || "").trimEnd();
  return template || DEFAULT_OUTPUT_TEMPLATE;
}

function collectRowOffsetsFromTemplate(template) {
  const offsets = new Set();
  const pattern = /\[t\d+,r([+-]?\d+),c\d+\]/gi;
  let match = pattern.exec(template);

  while (match) {
    offsets.add(Number(match[1]));
    match = pattern.exec(template);
  }

  if (!offsets.size) {
    offsets.add(-1);
  }

  return Array.from(offsets).sort((a, b) => a - b);
}

async function setReportStatus(reportId, status, detail = "") {
  activeRun.statuses[reportId] = {
    status,
    detail
  };
  await persistRuntimeState();
}

async function persistRuntimeState() {
  const runtimeState = publicRuntimeState();
  await storageSet({
    runtimeState
  });
  broadcastUpdate(runtimeState, activeRun.log);
}

function publicRuntimeState() {
  return {
    running: activeRun.running,
    statuses: activeRun.statuses
  };
}

async function appendLog(line) {
  if (typeof activeRun.log !== "string") {
    const stored = await storageGet("runLog");
    activeRun.log = stored.runLog || "";
  }

  activeRun.log += `[${formatClock(new Date())}] ${line}\n`;
  await storageSet({
    runLog: activeRun.log
  });
  broadcastUpdate(publicRuntimeState(), activeRun.log);
}

async function appendOutputBlock(block) {
  if (typeof activeRun.log !== "string") {
    const stored = await storageGet("runLog");
    activeRun.log = stored.runLog || "";
  }

  const normalizedBlock = String(block || "").trimEnd();
  if (!normalizedBlock) {
    return;
  }

  if (activeRun.log && !activeRun.log.endsWith("\n")) {
    activeRun.log += "\n";
  }
  activeRun.log += `${normalizedBlock}\n`;
  await storageSet({
    runLog: activeRun.log
  });
  broadcastUpdate(publicRuntimeState(), activeRun.log);
}

function formatContentLog(tab, payload) {
  const label = tab?.url ? shortUrl(tab.url) : "页面";
  return `${label}：${payload?.text || ""}`;
}

function formatReportResult(result, index, outputTemplate) {
  const lines = [renderOutputTemplate(outputTemplate, result)];

  if (hasParseProblem(result)) {
    lines.push("调试状态：");
    lines.push(...formatSectionProblemLines(result));
    lines.push(...formatDebugLines(result?.debug || []));
  }

  return lines.join("\n");
}

function formatFailure(errorText, result, index, outputTemplate) {
  const lines = [];

  if (result) {
    lines.push(renderOutputTemplate(outputTemplate, result));
  } else {
    lines.push("- ");
  }

  lines.push("调试状态：");
  lines.push(`- 解析失败：${errorText}`);
  lines.push(...formatSectionProblemLines(result));
  if (result?.debug?.length) {
    lines.push(...formatDebugLines(result.debug));
  }

  return lines.join("\n");
}

function renderOutputTemplate(template, result) {
  return normalizeOutputTemplate(template).replace(/\[([^\]]+)\]/g, (_whole, token) =>
    resolvePlaceholder(token.trim(), result)
  );
}

function resolvePlaceholder(token, result) {
  if (token === "code") {
    return result?.projectCode || "";
  }

  let match = /^t(\d+)$/i.exec(token);
  if (match) {
    return getSection(result, Number(match[1]))?.title || "";
  }

  match = /^t(\d+),h(\d+)$/i.exec(token);
  if (match) {
    const section = getSection(result, Number(match[1]));
    const headerIndex = Number(match[2]) - 1;
    return section?.headers?.[headerIndex] || "";
  }

  match = /^t(\d+),r([+-]?\d+),c(\d+)$/i.exec(token);
  if (match) {
    const section = getSection(result, Number(match[1]));
    const rowOffset = String(Number(match[2]));
    const columnIndex = Number(match[3]) - 1;
    return section?.rows?.[rowOffset]?.cells?.[columnIndex] || "";
  }

  return "";
}

function getSection(result, sectionNumber) {
  return result?.sections?.[sectionNumber - 1] || null;
}

function hasParseProblem(result) {
  if (!Array.isArray(result?.sections) || !result.sections.length) {
    return true;
  }

  return !result.projectCode || result.sections.some((section) => !section?.ok);
}

function formatSectionProblemLines(result) {
  if (!Array.isArray(result?.sections)) {
    return [];
  }

  return result.sections
    .filter((section) => !section.ok)
    .map((section) => {
      const title = section.title || section.key || "未知板块";
      return `- ${title}：${section.error || "未完整解析"}`;
    })
    .concat(result.projectCode ? [] : ["- 项目code：未匹配到 sonic_T????-.*"]);
}

function formatDebugLines(debug) {
  const limited = debug.slice(-80);
  return limited.map((entry) => {
    if (typeof entry === "string") {
      return `- ${compactText(entry, 500)}`;
    }
    return `- ${compactText(entry.text || JSON.stringify(entry), 500)}`;
  });
}

function compactText(text, maxLength) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}…`;
}

function shortUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.hash || ""}`;
  } catch (error) {
    return url;
  }
}

function broadcastUpdate(runtimeState, runLog) {
  chrome.runtime.sendMessage(
    {
      type: "RUN_UPDATE",
      payload: {
        runtimeState,
        runLog
      }
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish();
        return;
      }
      if (tab?.status === "complete") {
        finish();
      }
    });
  });
}

function storageGet(keys) {
  return callbackPromise((callback) => chrome.storage.local.get(keys, callback));
}

function storageSet(value) {
  return callbackPromise((callback) => chrome.storage.local.set(value, callback));
}

function tabsCreate(value) {
  return callbackPromise((callback) => chrome.tabs.create(value, callback));
}

function tabsUpdate(tabId, value) {
  return callbackPromise((callback) => chrome.tabs.update(tabId, value, callback));
}

function tabsRemove(tabId) {
  return callbackPromise((callback) => chrome.tabs.remove(tabId, callback));
}

function windowsUpdate(windowId, value) {
  return callbackPromise((callback) => chrome.windows.update(windowId, value, callback));
}

function sendTabMessage(tabId, message) {
  return callbackPromise((callback) => chrome.tabs.sendMessage(tabId, message, callback));
}

function scriptingExecuteScript(value) {
  return callbackPromise((callback) => chrome.scripting.executeScript(value, callback));
}

function callbackPromise(invoker) {
  return new Promise((resolve, reject) => {
    invoker((result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function formatClock(date) {
  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join(":");
}

function createId() {
  return `report-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageFromError(error) {
  if (!error) {
    return "未知错误";
  }
  return error.message || String(error);
}
