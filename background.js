const DEFAULT_REPORTS = [
  {
    id: "sample-ntba",
    url: "https://ntba.gte666.com/#/dashboard/11500_132528"
  }
];

const DEFAULT_CREDENTIALS = {
  account: "chenjianfeng",
  password: "tba@Jeff666"
};

const CONTENT_SCRIPT_FILE = "content.js";
const TAB_LOAD_TIMEOUT_MS = 60000;
const SNIFF_TIMEOUT_MS = 95000;
const CONTROL_WINDOW_WIDTH = 560;
const CONTROL_WINDOW_HEIGHT = 720;

let activeRun = {
  running: false,
  shouldStop: false,
  currentTabId: null,
  statuses: {},
  log: ""
};
let controlWindowId = null;

chrome.runtime.onInstalled.addListener(() => {
  initializeDefaults();
});

chrome.runtime.onStartup.addListener(() => {
  initializeDefaults();
});

chrome.action.onClicked.addListener(() => {
  openControlWindow();
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === controlWindowId) {
    controlWindowId = null;
  }
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
  const stored = await storageGet(["reports", "credentials"]);
  const next = {};

  if (!Array.isArray(stored.reports) || !stored.reports.length) {
    next.reports = DEFAULT_REPORTS;
  }

  if (!stored.credentials) {
    next.credentials = DEFAULT_CREDENTIALS;
  }

  if (Object.keys(next).length) {
    await storageSet(next);
  }
}

async function openControlWindow() {
  if (controlWindowId) {
    try {
      await windowsUpdate(controlWindowId, {
        focused: true
      });
      return;
    } catch (error) {
      controlWindowId = null;
    }
  }

  const created = await windowsCreate({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: CONTROL_WINDOW_WIDTH,
    height: CONTROL_WINDOW_HEIGHT,
    focused: true
  });
  controlWindowId = created.id;
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
    runLog: "",
    runtimeState: publicRuntimeState()
  });

  await appendLog(`任务开始，共 ${reports.length} 个网址`);

  void runQueue(reports, credentials).catch(async (error) => {
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

async function runQueue(reports, credentials) {
  if (!reports.length) {
    await appendLog("没有可执行的网址");
  }

  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];

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
      activeRun.currentTabId = tab.id;
      await focusTab(tab.id, tab.windowId);

      await setReportStatus(report.id, "等待加载", report.url);
      await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);

      await setReportStatus(report.id, "解析中", report.url);
      const response = await runSniffOnTab(tab.id, {
        report,
        credentials,
        timeoutMs: SNIFF_TIMEOUT_MS
      });

      if (response?.ok) {
        const isComplete = !hasParseProblem(response.result);
        await setReportStatus(report.id, isComplete ? "完成" : "完成(有缺失)", "解析完成");
        await appendLog(formatReportResult(report, response.result, index));
      } else {
        const errorText = response?.error || "页面脚本未返回结果";
        await setReportStatus(report.id, "失败", errorText);
        await appendLog(formatFailure(report, errorText, response?.result, index));
      }
    } catch (error) {
      const errorText = messageFromError(error);
      await setReportStatus(report.id, "失败", errorText);
      await appendLog(formatFailure(report, errorText, null, index));
    } finally {
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
  const source = Array.isArray(value) && value.length ? value : DEFAULT_REPORTS;
  return source
    .map((report) => ({
      id: report.id || createId(),
      url: String(report.url || "").trim()
    }))
    .filter((report) => report.url);
}

function normalizeCredentials(value) {
  return {
    account: String(value?.account || DEFAULT_CREDENTIALS.account || "").trim(),
    password: String(value?.password || DEFAULT_CREDENTIALS.password || "")
  };
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

function formatContentLog(tab, payload) {
  const label = tab?.url ? shortUrl(tab.url) : "页面";
  return `${label}：${payload?.text || ""}`;
}

function formatReportResult(report, result, index) {
  const lines = [
    "",
    `========== [${index + 1}] ${report.url} ==========`,
    `页面标题：${result?.title || "未知"}`,
    `目标日期：${result?.targetDateLabel || "未知"}`
  ];

  const business = result?.groups?.business;
  const core = result?.groups?.core;

  lines.push(formatGroup("经营数据", business, ["消耗", "毛利"]));
  lines.push(formatGroup("核心指标", core, ["d0", "PV", "渗透率-TT", "渗透率-GG"]));

  if (hasParseProblem(result)) {
    lines.push("调试状态：");
    lines.push(...formatDebugLines(result?.debug || []));
  }

  return lines.join("\n");
}

function formatFailure(report, errorText, result, index) {
  const lines = [
    "",
    `========== [${index + 1}] ${report.url} ==========`,
    `解析失败：${errorText}`
  ];

  if (result?.debug?.length) {
    lines.push("调试状态：");
    lines.push(...formatDebugLines(result.debug));
  }

  return lines.join("\n");
}

function formatGroup(title, group, fields) {
  if (!group) {
    return `${title}：未返回`;
  }

  const values = fields.map((field) => {
    const item = group.fields?.[field];
    return `${field}=${item?.value || "未找到"}`;
  });

  const rowInfo = group.rowText ? `；行=${compactText(group.rowText, 120)}` : "";
  const suffix = group.ok ? "" : `；状态=${group.error || "未完整解析"}`;
  return `${title}：${values.join("，")}${suffix}${rowInfo}`;
}

function hasParseProblem(result) {
  if (!result?.groups) {
    return true;
  }

  return Object.values(result.groups).some((group) => !group?.ok);
}

function formatDebugLines(debug) {
  const limited = debug.slice(-80);
  return limited.map((entry) => {
    if (typeof entry === "string") {
      return `- ${entry}`;
    }
    return `- ${entry.text || JSON.stringify(entry)}`;
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

function windowsUpdate(windowId, value) {
  return callbackPromise((callback) => chrome.windows.update(windowId, value, callback));
}

function windowsCreate(value) {
  return callbackPromise((callback) => chrome.windows.create(value, callback));
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
