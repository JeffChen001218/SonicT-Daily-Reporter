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

const reportsList = document.querySelector("#reportsList");
const accountInput = document.querySelector("#accountInput");
const passwordInput = document.querySelector("#passwordInput");
const startBtn = document.querySelector("#startBtn");
const stopBtn = document.querySelector("#stopBtn");
const addReportBtn = document.querySelector("#addReportBtn");
const outputArea = document.querySelector("#outputArea");
const runState = document.querySelector("#runState");
const copyBtn = document.querySelector("#copyBtn");
const clearBtn = document.querySelector("#clearBtn");

let reports = [];
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
    "runtimeState",
    "runLog"
  ]);

  reports = normalizeReports(stored.reports);
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

  startBtn.addEventListener("click", async () => {
    await saveConfig();
    const payload = {
      reports: reports.filter((report) => report.url.trim()),
      credentials: collectCredentials()
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
    if (typeof message.payload?.runLog === "string") {
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

function normalizeReports(value) {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_REPORTS;
  return source.map((report) => ({
    id: report.id || createId(),
    url: report.url || ""
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
    credentials: collectCredentials()
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
