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

const reportsList = document.querySelector("#reportsList");
const parseSectionsList = document.querySelector("#parseSectionsList");
const accountInput = document.querySelector("#accountInput");
const passwordInput = document.querySelector("#passwordInput");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const addReportBtn = document.querySelector("#addReportBtn");
const importOpenTbaBtn = document.querySelector("#importOpenTbaBtn");
const addSectionBtn = document.querySelector("#addSectionBtn");
const templateArea = document.querySelector("#templateArea");
const outputArea = document.querySelector("#outputArea");
const runState = document.querySelector("#runState");
const copyBtn = document.querySelector("#copyBtn");
const clearBtn = document.querySelector("#clearBtn");

let reports = [];
let parseSections = [];
let runtimeState = {
  running: false,
  statuses: {}
};
let saveTimer = 0;

init();

async function init() {
  const stored = await chrome.storage.local.get([
    "reports",
    "credentials",
    "parseSections",
    "outputTemplate",
    "runtimeState",
    "runLog"
  ]);

  reports = normalizeReports(stored.reports);
  parseSections = normalizeParseSections(stored.parseSections);
  const credentials = {
    ...DEFAULT_CREDENTIALS,
    ...(stored.credentials || {})
  };
  runtimeState = {
    ...runtimeState,
    ...(stored.runtimeState || {})
  };

  accountInput.value = credentials.account || "";
  passwordInput.value = credentials.password || "";
  templateArea.value = stored.outputTemplate || DEFAULT_OUTPUT_TEMPLATE;
  outputArea.value = stored.runLog || "";

  render();
  bindEvents();
  refreshStateFromBackground();
}

function bindEvents() {
  addReportBtn.addEventListener("click", () => {
    reports.push({
      id: createId(),
      url: ""
    });
    renderReports();
    scheduleSave();
  });

  importOpenTbaBtn.addEventListener("click", importOpenTbaTabs);

  addSectionBtn.addEventListener("click", () => {
    parseSections.push({
      id: createId(),
      title: ""
    });
    renderParseSections();
    scheduleSave();
  });

  startBtn.addEventListener("click", async () => {
    await saveConfig();
    const payload = {
      reports: reports.filter((report) => report.url.trim()),
      credentials: collectCredentials(),
      parseSections: parseSections.filter((section) => section.title.trim()),
      outputTemplate: templateArea.value
    };
    await chrome.runtime.sendMessage({
      type: "START_RUN",
      payload
    });
    await refreshStateFromBackground();
  });

  stopBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: "STOP_RUN"
    });
    await refreshStateFromBackground();
  });

  [accountInput, passwordInput].forEach((input) => {
    input.addEventListener("input", scheduleSave);
  });

  templateArea.addEventListener("input", scheduleSave);

  outputArea.addEventListener("input", () => {
    chrome.storage.local.set({
      runLog: outputArea.value
    });
  });

  copyBtn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(outputArea.value);
  });

  clearBtn.addEventListener("click", async () => {
    outputArea.value = "";
    await chrome.storage.local.set({
      runLog: ""
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "RUN_UPDATE") {
      return;
    }
    runtimeState = {
      ...runtimeState,
      ...(message.payload?.runtimeState || {})
    };
    if (typeof message.payload?.runLog === "string" && document.activeElement !== outputArea) {
      outputArea.value = message.payload.runLog;
      outputArea.scrollTop = outputArea.scrollHeight;
    }
    render();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (changes.runtimeState) {
      runtimeState = {
        ...runtimeState,
        ...(changes.runtimeState.newValue || {})
      };
      render();
    }
    if (changes.runLog && document.activeElement !== outputArea) {
      outputArea.value = changes.runLog.newValue || "";
      outputArea.scrollTop = outputArea.scrollHeight;
    }
  });
}

function render() {
  renderReports();
  renderParseSections();
  runState.textContent = runtimeState.running ? "运行中" : "待命";
  startBtn.disabled = runtimeState.running;
  stopBtn.disabled = !runtimeState.running;
}

function renderReports() {
  reportsList.textContent = "";

  if (!reports.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无网址";
    reportsList.append(empty);
    return;
  }

  reports.forEach((report, index) => {
    const row = document.createElement("div");
    row.className = "report-row";

    const input = document.createElement("input");
    input.type = "url";
    input.placeholder = "https://...";
    input.value = report.url || "";
    input.addEventListener("input", () => {
      reports[index] = {
        ...reports[index],
        url: input.value
      };
      scheduleSave();
    });

    const status = runtimeState.statuses?.[report.id] || {
      status: "待处理"
    };
    const pill = document.createElement("span");
    pill.className = `status-pill ${statusClass(status.status)}`;
    pill.title = status.detail || status.status || "待处理";
    pill.textContent = status.status || "待处理";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost remove-btn";
    remove.textContent = "×";
    remove.title = "删除";
    remove.addEventListener("click", () => {
      reports = reports.filter((item) => item.id !== report.id);
      renderReports();
      scheduleSave();
    });

    row.append(input, pill, remove);
    reportsList.append(row);
  });
}

function renderParseSections() {
  parseSectionsList.textContent = "";

  if (!parseSections.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无解析板块";
    parseSectionsList.append(empty);
    return;
  }

  parseSections.forEach((section, index) => {
    const row = document.createElement("div");
    row.className = "section-row";

    const code = document.createElement("span");
    code.className = "section-code";
    code.textContent = `t${index + 1}`;
    code.title = `模版通配符前缀：t${index + 1}`;

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "板块名称，例如：经营数据";
    input.value = section.title || "";
    input.addEventListener("input", () => {
      parseSections[index] = {
        ...parseSections[index],
        title: input.value
      };
      scheduleSave();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost remove-btn";
    remove.textContent = "×";
    remove.title = "删除";
    remove.addEventListener("click", () => {
      parseSections = parseSections.filter((item) => item.id !== section.id);
      renderParseSections();
      scheduleSave();
    });

    row.append(code, input, remove);
    parseSectionsList.append(row);
  });
}

async function importOpenTbaTabs() {
  const tabs = await chrome.tabs.query({});
  const existingUrls = new Set(reports.map((report) => normalizeUrlForCompare(report.url)).filter(Boolean));
  const tbaTabs = tabs
    .filter((tab) => isTbaUrl(tab.url))
    .sort((a, b) => {
      if (a.windowId !== b.windowId) {
        return a.windowId - b.windowId;
      }
      return a.index - b.index;
    });

  let imported = 0;
  let skipped = 0;

  tbaTabs.forEach((tab) => {
    const normalizedUrl = normalizeUrlForCompare(tab.url);
    if (!normalizedUrl || existingUrls.has(normalizedUrl)) {
      skipped += 1;
      return;
    }

    existingUrls.add(normalizedUrl);
    reports.push({
      id: createId(),
      url: tab.url
    });
    imported += 1;
  });

  renderReports();
  await saveConfig();
  runState.textContent = `已导入 ${imported} 个，跳过 ${skipped} 个`;
}

function normalizeReports(value) {
  if (isLegacyDefaultReports(value)) {
    return [];
  }

  const source = Array.isArray(value) ? value : DEFAULT_REPORTS;
  return source.map((report) => ({
    id: report.id || createId(),
    url: report.url || ""
  }));
}

function isLegacyDefaultReports(value) {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    normalizeUrlForCompare(value[0]?.url) === normalizeUrlForCompare(LEGACY_DEFAULT_REPORT_URL)
  );
}

function isTbaUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "ntba.gte666.com";
  } catch (error) {
    return false;
  }
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

function normalizeParseSections(value) {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_PARSE_SECTIONS;
  return source.map((section) => ({
    id: section.id || createId(),
    title: section.title || section.name || ""
  }));
}

function collectCredentials() {
  return {
    account: accountInput.value.trim(),
    password: passwordInput.value
  };
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveConfig, 250);
}

async function saveConfig() {
  await chrome.storage.local.set({
    reports,
    credentials: collectCredentials(),
    parseSections,
    outputTemplate: templateArea.value
  });
}

async function refreshStateFromBackground() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GET_STATE"
    });
    if (response?.ok) {
      runtimeState = {
        ...runtimeState,
        ...(response.runtimeState || {})
      };
      if (typeof response.runLog === "string") {
        outputArea.value = response.runLog;
        outputArea.scrollTop = outputArea.scrollHeight;
      }
      render();
    }
  } catch (error) {
    runState.textContent = "后台未响应";
  }
}

function statusClass(status) {
  if (/完成|成功/.test(status || "")) {
    return "done";
  }
  if (/失败|错误|超时/.test(status || "")) {
    return "error";
  }
  if (/打开|登录|解析|等待|停止/.test(status || "")) {
    return "running";
  }
  return "";
}

function createId() {
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `report-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
