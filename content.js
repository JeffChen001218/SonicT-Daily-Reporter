(() => {
  if (window.__SONIC_DAILY_CONTENT_INSTALLED__) {
    return;
  }
  window.__SONIC_DAILY_CONTENT_INSTALLED__ = true;

  const TARGET_SECTIONS = [
    {
      key: "business",
      title: "经营数据",
      fields: ["消耗", "毛利"]
    },
    {
      key: "core",
      title: "核心指标",
      fields: ["d0", "PV", "渗透率-TT", "渗透率-GG"]
    }
  ];
  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  const DEFAULT_TIMEOUT_MS = 90000;

  let cancelRequested = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING") {
      sendResponse({
        ok: true
      });
      return false;
    }

    if (message?.type === "STOP_SNIFF") {
      cancelRequested = true;
      sendResponse({
        ok: true
      });
      return false;
    }

    if (message?.type === "RUN_SNIFF") {
      cancelRequested = false;
      runSniff(message.payload || {})
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            ok: false,
            error: messageFromError(error)
          });
        });
      return true;
    }

    return false;
  });

  async function runSniff(payload) {
    const debug = [];
    const targetDate = getYesterday();
    const targetDateText = formatDate(targetDate);
    const targetDateLabel = `${targetDateText}(${WEEKDAYS[targetDate.getDay()]})`;
    const timeoutMs = Number(payload.timeoutMs || DEFAULT_TIMEOUT_MS);

    const log = (text, extra) => {
      const line = extra ? `${text} ${JSON.stringify(extra)}` : text;
      debug.push({
        text: line
      });
      sendContentLog(line);
    };

    log(`开始页面嗅探，目标日期 ${targetDateLabel}`);
    await waitForDomReady();

    const loginResult = await maybeLogin(payload.credentials || {}, log);
    if (loginResult.attempted) {
      log(loginResult.clicked ? "已尝试自动登录，等待页面进入报表" : "已填充登录信息，未找到明确登录按钮");
      await waitForReportReady(targetDateText, timeoutMs, log).catch((error) => {
        log(`登录后等待报表超时：${messageFromError(error)}`);
      });
    }

    await waitForReportReady(targetDateText, timeoutMs, log).catch((error) => {
      log(`等待报表超时：${messageFromError(error)}`);
    });

    throwIfStopped();

    const models = collectTableModels();
    log(`发现表格候选 ${models.length} 个`);

    const groups = {};
    for (const section of TARGET_SECTIONS) {
      groups[section.key] = parseSection(section, models, {
        targetDateText,
        targetDateLabel,
        log
      });
    }

    return {
      ok: Object.values(groups).some((group) => group.ok),
      result: {
        url: location.href,
        title: document.title,
        targetDateText,
        targetDateLabel,
        groups,
        debug
      }
    };
  }

  async function maybeLogin(credentials, log) {
    const account = String(credentials.account || "").trim();
    const password = String(credentials.password || "");
    if (!account || !password) {
      return {
        attempted: false,
        clicked: false
      };
    }

    const passwordInput = findVisibleInput("password");
    if (!passwordInput) {
      log("未发现密码输入框，跳过自动登录");
      return {
        attempted: false,
        clicked: false
      };
    }

    const container = passwordInput.closest("form") || findNearbyFormContainer(passwordInput) || document.body;
    const accountInput = findAccountInput(container, passwordInput) || findAccountInput(document.body, passwordInput);
    if (!accountInput) {
      log("发现密码框，但未定位到账户输入框");
      return {
        attempted: false,
        clicked: false
      };
    }

    setInputValue(accountInput, account);
    setInputValue(passwordInput, password);
    log("已填充账户和密码");

    const button = findLoginButton(container) || findLoginButton(document.body);
    if (button) {
      button.click();
      return {
        attempted: true,
        clicked: true
      };
    }

    passwordInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true
      })
    );
    return {
      attempted: true,
      clicked: false
    };
  }

  async function waitForReportReady(targetDateText, timeoutMs, log) {
    await waitForCondition(
      () => {
        throwIfStopped();
        const pageText = getVisibleText(document.body);
        const hasSection = TARGET_SECTIONS.some((section) => pageText.includes(section.title));
        const hasDate = pageText.includes(targetDateText);
        return hasSection && hasDate;
      },
      timeoutMs,
      800
    );
    log("页面中已发现目标日期和目标板块文字");
  }

  function parseSection(section, models, context) {
    const candidates = rankModelsForSection(models, section.title);
    const debugPrefix = `[${section.title}]`;
    context.log(`${debugPrefix} 候选表格 ${candidates.length} 个`);

    for (const model of candidates) {
      const row = findTargetRow(model, context.targetDateLabel, context.targetDateText);
      if (!row) {
        continue;
      }

      const fields = {};
      const missing = [];
      for (const field of section.fields) {
        const match = findFieldValue(model, row, field);
        fields[field] = match;
        if (!match.value) {
          missing.push(field);
        }
      }

      context.log(`${debugPrefix} 命中表格 #${model.index}`, {
        headers: model.headers,
        row: row.cells
      });

      return {
        ok: missing.length === 0,
        title: section.title,
        tableIndex: model.index,
        rowText: row.text,
        headers: model.headers,
        fields,
        error: missing.length ? `未找到列：${missing.join("、")}` : ""
      };
    }

    const fallback = candidates.slice(0, 3).map((model) => ({
      tableIndex: model.index,
      headers: model.headers,
      rowCount: model.rows.length,
      sampleRows: model.rows.slice(0, 3).map((row) => row.cells)
    }));

    context.log(`${debugPrefix} 未找到目标日期行`, fallback);
    return {
      ok: false,
      title: section.title,
      tableIndex: -1,
      rowText: "",
      headers: [],
      fields: Object.fromEntries(
        section.fields.map((field) => [
          field,
          {
            value: "",
            columnIndex: -1,
            header: ""
          }
        ])
      ),
      error: `未找到 ${context.targetDateLabel} 所在行`
    };
  }

  function collectTableModels() {
    const roots = new Set();
    const selectors = [
      ".ant-table",
      ".el-table",
      ".vxe-table",
      ".arco-table",
      ".semi-table",
      "[role='table']",
      "table"
    ].join(",");

    document.querySelectorAll(selectors).forEach((node) => {
      const root =
        node.closest(".ant-table,.el-table,.vxe-table,.arco-table,.semi-table,[role='table']") ||
        node;
      if (isVisible(root)) {
        roots.add(root);
      }
    });

    return Array.from(roots)
      .map((root, index) => buildTableModel(root, index))
      .filter((model) => model.rows.length);
  }

  function buildTableModel(root, index) {
    const headerRows = collectHeaderRows(root);
    const bodyRows = collectBodyRows(root, headerRows);
    const headers = buildHeaders(headerRows);
    const headerInfos = buildHeaderInfos(headerRows);
    const rows = buildBodyRowModels(bodyRows);

    return {
      index,
      root,
      headers,
      headerInfos,
      rows
    };
  }

  function buildBodyRowModels(bodyRows) {
    const rowGroups = [];

    bodyRows.forEach((rowNode) => {
      const cellInfos = collectCells(rowNode)
        .filter((cell) => !isHeaderCell(cell))
        .map(cellToInfo)
        .filter((cell) => cell.text);

      if (!cellInfos.length) {
        return;
      }

      const rect = rowNode.getBoundingClientRect();
      let group = rowGroups.find((item) => Math.abs(item.top - rect.top) <= 3);
      if (!group) {
        group = {
          top: rect.top,
          parts: []
        };
        rowGroups.push(group);
      }
      group.parts.push({
        node: rowNode,
        cells: cellInfos
      });
    });

    const rows = [];
    const seen = new Set();

    rowGroups
      .sort((a, b) => a.top - b.top)
      .forEach((group) => {
        const cellInfos = dedupeCellInfos(group.parts.flatMap((part) => part.cells)).sort(
          (a, b) => a.left - b.left
        );
        const cells = cellInfos.map((cell) => cell.text);
        const rowText = cells.join(" | ");
        if (seen.has(rowText)) {
          return;
        }
        seen.add(rowText);
        rows.push({
          node: group.parts[0].node,
          cellInfos,
          cells,
          text: rowText
        });
      });

    return rows;
  }

  function collectHeaderRows(root) {
    const rows = Array.from(
      root.querySelectorAll(
        [
          "thead tr",
          ".ant-table-thead tr",
          ".el-table__header-wrapper tr",
          ".vxe-table--header tr",
          ".arco-table-thead tr",
          ".semi-table-thead tr"
        ].join(",")
      )
    ).filter(isVisible);

    if (rows.length) {
      return uniqueNodes(rows);
    }

    return Array.from(root.querySelectorAll("[role='row']"))
      .filter(isVisible)
      .filter((row) => collectCells(row).some(isHeaderCell));
  }

  function collectBodyRows(root, headerRows) {
    const rows = Array.from(
      root.querySelectorAll(
        [
          "tbody tr",
          ".ant-table-tbody tr",
          ".el-table__body-wrapper tr",
          ".vxe-table--body tr",
          ".arco-table-tbody tr",
          ".semi-table-tbody tr"
        ].join(",")
      )
    ).filter(isVisible);

    if (rows.length) {
      return uniqueNodes(rows);
    }

    const headerSet = new Set(headerRows);
    return Array.from(root.querySelectorAll("tr,[role='row']"))
      .filter(isVisible)
      .filter((row) => !headerSet.has(row));
  }

  function collectCells(row) {
    return Array.from(row.children).filter((child) => {
      const tag = child.tagName?.toLowerCase();
      const role = child.getAttribute?.("role");
      return tag === "td" || tag === "th" || role === "cell" || role === "columnheader";
    });
  }

  function buildHeaders(headerRows) {
    if (!headerRows.length) {
      return [];
    }

    const grid = [];
    headerRows.forEach((row, rowIndex) => {
      grid[rowIndex] ||= [];
      let columnIndex = 0;
      collectCells(row).forEach((cell) => {
        while (grid[rowIndex][columnIndex]) {
          columnIndex += 1;
        }

        const text = cleanText(getVisibleText(cell));
        const colSpan = Number(cell.getAttribute("colspan") || cell.colSpan || 1);
        const rowSpan = Number(cell.getAttribute("rowspan") || cell.rowSpan || 1);

        for (let r = 0; r < rowSpan; r += 1) {
          for (let c = 0; c < colSpan; c += 1) {
            grid[rowIndex + r] ||= [];
            grid[rowIndex + r][columnIndex + c] = text;
          }
        }
        columnIndex += colSpan;
      });
    });

    const maxColumns = grid.reduce((max, row) => Math.max(max, row.length), 0);
    const headers = [];

    for (let columnIndex = 0; columnIndex < maxColumns; columnIndex += 1) {
      const parts = [];
      grid.forEach((row) => {
        const part = row[columnIndex];
        if (part && parts[parts.length - 1] !== part) {
          parts.push(part);
        }
      });
      headers[columnIndex] = parts.join("/");
    }

    return headers;
  }

  function buildHeaderInfos(headerRows) {
    return dedupeCellInfos(
      headerRows.flatMap((row) => collectCells(row).map(cellToInfo).filter((cell) => cell.text))
    ).sort((a, b) => {
      if (Math.abs(a.top - b.top) > 3) {
        return a.top - b.top;
      }
      return a.left - b.left;
    });
  }

  function rankModelsForSection(models, title) {
    const titleNodes = findTitleNodes(title);
    const scored = models.map((model) => ({
      model,
      score: scoreModelForTitle(model, title, titleNodes)
    }));

    const direct = scored
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.model);

    const fallback = scored
      .filter((item) => item.score <= 0)
      .map((item) => item.model);

    return [...direct, ...fallback];
  }

  function findTitleNodes(title) {
    return Array.from(
      document.querySelectorAll(
        "h1,h2,h3,h4,h5,h6,header,section,article,div,span,p,.ant-card-head-title,.el-card__header"
      )
    ).filter((node) => {
      if (!isVisible(node)) {
        return false;
      }
      const text = cleanText(getVisibleText(node));
      return text.includes(title) && text.length <= 220;
    });
  }

  function scoreModelForTitle(model, title, titleNodes) {
    let score = 0;
    const rootRect = model.root.getBoundingClientRect();
    const rootText = cleanText(getVisibleText(model.root));

    if (rootText.includes(title)) {
      score += 20;
    }

    for (const titleNode of titleNodes) {
      let ancestor = titleNode;
      for (let depth = 0; depth < 8 && ancestor && ancestor !== document.body; depth += 1) {
        if (ancestor.contains(model.root)) {
          score += Math.max(12, 80 - depth * 8);
          break;
        }
        ancestor = ancestor.parentElement;
      }

      const titleRect = titleNode.getBoundingClientRect();
      const distance = rootRect.top - titleRect.top;
      if (distance > -40 && distance < 1200) {
        score += Math.max(1, 45 - distance / 24);
      }
    }

    return score;
  }

  function findTargetRow(model, targetDateLabel, targetDateText) {
    return model.rows.find((row) => row.text.includes(targetDateLabel)) ||
      model.rows.find((row) => row.text.includes(targetDateText));
  }

  function findFieldValue(model, row, field) {
    const fieldIndex = findHeaderIndex(model.headers, field);
    if (fieldIndex >= 0) {
      const value = row.cells[fieldIndex] || "";
      if (value) {
        return {
          value,
          columnIndex: fieldIndex,
          header: model.headers[fieldIndex] || ""
        };
      }
    }

    const spatialMatch = findFieldValueByPosition(model, row, field);
    if (spatialMatch.value) {
      return spatialMatch;
    }

    if (fieldIndex >= 0) {
      return {
        value: "",
        columnIndex: fieldIndex,
        header: model.headers[fieldIndex] || ""
      };
    }

    return {
      value: "",
      columnIndex: -1,
      header: ""
    };
  }

  function findFieldValueByPosition(model, row, field) {
    const matchedHeaders = model.headerInfos
      .filter((header) => headerMatchesField(header.text, field))
      .sort((a, b) => Math.abs(normalizeHeader(a.text).length - normalizeHeader(field).length) -
        Math.abs(normalizeHeader(b.text).length - normalizeHeader(field).length));

    for (const header of matchedHeaders) {
      const nearestCell = row.cellInfos
        .map((cell) => ({
          cell,
          distance: Math.abs(cell.centerX - header.centerX)
        }))
        .sort((a, b) => a.distance - b.distance)[0];

      if (nearestCell && nearestCell.distance <= Math.max(80, header.width * 0.9)) {
        return {
          value: nearestCell.cell.text,
          columnIndex: -1,
          header: header.text
        };
      }
    }

    return {
      value: "",
      columnIndex: -1,
      header: ""
    };
  }

  function findHeaderIndex(headers, field) {
    const normalizedField = normalizeHeader(field);
    const exactIndex = headers.findIndex((header) => normalizeHeader(header) === normalizedField);
    if (exactIndex >= 0) {
      return exactIndex;
    }

    return headers.findIndex((header) => headerMatchesField(header, field));
  }

  function headerMatchesField(header, field) {
    const normalizedHeader = normalizeHeader(header);
    const normalizedField = normalizeHeader(field);

    if (!normalizedHeader) {
      return false;
    }

    if (field === "渗透率-TT") {
      return normalizedHeader.includes("渗透率") && normalizedHeader.includes("tt");
    }

    if (field === "渗透率-GG") {
      return normalizedHeader.includes("渗透率") && normalizedHeader.includes("gg");
    }

    if (field.toLowerCase() === "pv") {
      return normalizedHeader === "pv" || normalizedHeader.includes("pv");
    }

    if (field.toLowerCase() === "d0") {
      return normalizedHeader === "d0" || normalizedHeader.includes("d0");
    }

    return normalizedHeader.includes(normalizedField);
  }

  function normalizeHeader(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[：:()（）\[\]【】_%/\\|]/g, "")
      .replace(/[‐‑‒–—-]/g, "");
  }

  function findVisibleInput(type) {
    return Array.from(document.querySelectorAll(`input[type='${type}']`)).find(isUsableInput);
  }

  function findNearbyFormContainer(input) {
    let node = input.parentElement;
    for (let depth = 0; depth < 5 && node; depth += 1) {
      const inputCount = node.querySelectorAll("input").length;
      if (inputCount >= 2) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function findAccountInput(container, passwordInput) {
    const inputs = Array.from(
      container.querySelectorAll(
        "input:not([type]),input[type='text'],input[type='email'],input[type='tel'],input[type='number'],input[type='search']"
      )
    ).filter((input) => input !== passwordInput && isUsableInput(input));

    const preferred = inputs.find((input) => {
      const hint = [
        input.name,
        input.id,
        input.placeholder,
        input.autocomplete,
        input.getAttribute("aria-label")
      ]
        .filter(Boolean)
        .join(" ");
      return /user|account|login|name|phone|email|账号|帐号|账户|用户名|手机|邮箱/i.test(hint);
    });

    return preferred || inputs[0] || null;
  }

  function findLoginButton(container) {
    const candidates = Array.from(
      container.querySelectorAll("button,input[type='submit'],input[type='button'],[role='button']")
    ).filter((node) => isVisible(node) && !node.disabled);

    return (
      candidates.find((node) => /登录|登陆|log\s*in|sign\s*in|submit|进入/i.test(getButtonText(node))) ||
      candidates.find((node) => node.type === "submit") ||
      candidates[0] ||
      null
    );
  }

  function getButtonText(node) {
    return cleanText(
      [node.innerText, node.value, node.getAttribute("aria-label"), node.title].filter(Boolean).join(" ")
    );
  }

  function setInputValue(input, value) {
    input.focus();
    const prototype = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(
      new Event("input", {
        bubbles: true
      })
    );
    input.dispatchEvent(
      new Event("change", {
        bubbles: true
      })
    );
  }

  function isUsableInput(input) {
    return isVisible(input) && !input.disabled && !input.readOnly;
  }

  function isHeaderCell(cell) {
    return cell.tagName?.toLowerCase() === "th" || cell.getAttribute?.("role") === "columnheader";
  }

  function cellToInfo(cell) {
    const rect = cell.getBoundingClientRect();
    return {
      text: cleanText(getVisibleText(cell)),
      left: rect.left,
      top: rect.top,
      width: rect.width,
      centerX: rect.left + rect.width / 2
    };
  }

  function dedupeCellInfos(cells) {
    const seen = new Set();
    return cells.filter((cell) => {
      const key = `${Math.round(cell.left)}:${Math.round(cell.top)}:${cell.text}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function isVisible(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getVisibleText(node) {
    if (!node) {
      return "";
    }
    return node.innerText || node.textContent || "";
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function uniqueNodes(nodes) {
    return Array.from(new Set(nodes));
  }

  function getYesterday() {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return date;
  }

  function formatDate(date) {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function waitForDomReady() {
    if (document.readyState === "interactive" || document.readyState === "complete") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      document.addEventListener("DOMContentLoaded", resolve, {
        once: true
      });
    });
  }

  async function waitForCondition(predicate, timeoutMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) {
        return true;
      }
      await sleep(intervalMs);
    }
    throw new Error(`等待超时 ${timeoutMs}ms`);
  }

  function throwIfStopped() {
    if (cancelRequested) {
      throw new Error("任务已停止");
    }
  }

  function sendContentLog(text) {
    chrome.runtime.sendMessage(
      {
        type: "CONTENT_LOG",
        payload: {
          text
        }
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
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
})();
