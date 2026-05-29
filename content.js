(() => {
  if (window.__SONIC_DAILY_CONTENT_INSTALLED__) {
    return;
  }
  window.__SONIC_DAILY_CONTENT_INSTALLED__ = true;

  const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  const DEFAULT_TIMEOUT_MS = 90000;
  const PARSE_RETRY_INTERVAL_MS = 1500;
  const DEFAULT_ROW_OFFSETS = [-1];
  const PANEL_TABLE_MISSING_RETRY_MS = 12000;
  const TEMPLATE_FIELD_STALE_RETRY_MS = 60000;
  const DATE_HEADER_PATTERN = /^(日期|时间|date|day)$/i;
  const DATE_CELL_PATTERN = /^\d{4}-\d{2}-\d{2}(?:\([^)]*\))?$/;
  const PANEL_STATUS_OVERLAY_ID = "__sonic_daily_panel_status_overlay__";
  const PANEL_STATUS_LOG_LIMIT = 12;

  let cancelRequested = false;
  let panelStatusOverlayRows = [];
  let panelStatusOverlayLog = [];
  let panelStatusOverlayLastFingerprint = "";
  let panelStatusOverlayHidden = false;

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
    const parseSections = normalizeParseSections(payload.parseSections);
    const rowOffsets = normalizeRowOffsets(payload.rowOffsets);
    const templateRequirements = normalizeTemplateRequirements(payload.templateRequirements);
    const rowTargets = Object.fromEntries(
      rowOffsets.map((offset) => {
        const date = getDateByOffset(offset);
        const dateText = formatDate(date);
        return [
          String(offset),
          {
            offset,
            dateText,
            label: `${dateText}(${WEEKDAYS[date.getDay()]})`
          }
        ];
      })
    );
    const primaryTarget = rowTargets["-1"] || rowTargets[String(rowOffsets[0])];
    const timeoutMs = Number(payload.timeoutMs || DEFAULT_TIMEOUT_MS);

    const log = (text, extra) => {
      const line = extra ? `${text} ${JSON.stringify(extra)}` : text;
      debug.push({
        text: line
      });
      sendContentLog(line);
      addPanelStatusOverlayLog(line);
    };

    resetPanelStatusOverlay(parseSections);
    log(`开始页面嗅探，解析板块 ${parseSections.map((section) => section.title).join("、") || "未配置"}`);
    log(`目标行 ${Object.values(rowTargets).map((target) => `r${target.offset}:${target.label}`).join("、")}`);
    await waitForDomReady();
    renderPanelStatusOverlay();

    const loginResult = await maybeLogin(payload.credentials || {}, log);
    if (loginResult.attempted) {
      log(loginResult.clicked ? "已尝试自动登录，等待页面进入报表" : "已填充登录信息，未找到明确登录按钮");
    }

    throwIfStopped();

    const projectCodeMatch = findProjectCode();
    if (projectCodeMatch.code) {
      log(`项目code命中 ${projectCodeMatch.fullMatch}`);
    } else {
      log("项目code未命中，已按 sonic_T????-.* 全局查询");
    }

    const parseResult = await waitForCompleteParse({
      parseSections,
      rowTargets,
      rowOffsets,
      templateRequirements,
      timeoutMs,
      log
    });
    const sections = parseResult.sections;

    if (parseResult.needsRetry) {
      return {
        ok: false,
        needsRetry: true,
        error: parseResult.error,
        result: {
          url: location.href,
          title: document.title,
          projectCode: projectCodeMatch.code,
          projectCodeMatch: projectCodeMatch.fullMatch,
          targetDateText: primaryTarget?.dateText || "",
          targetDateLabel: primaryTarget?.label || "",
          rowTargets,
          sections,
          debug
        }
      };
    }

    return {
      ok: isCompleteParse(sections, parseSections, templateRequirements),
      result: {
        url: location.href,
        title: document.title,
        projectCode: projectCodeMatch.code,
        projectCodeMatch: projectCodeMatch.fullMatch,
        targetDateText: primaryTarget?.dateText || "",
        targetDateLabel: primaryTarget?.label || "",
        rowTargets,
        sections,
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

  async function waitForCompleteParse(options) {
    const startedAt = Date.now();
    let lastResult = parseAllSections({
      ...options,
      silent: true
    });
    let lastSummary = "";
    let tableMissingSince = 0;
    let templatePendingSince = 0;

    while (Date.now() - startedAt < options.timeoutMs) {
      throwIfStopped();
      lastResult = parseAllSections({
        ...options,
        silent: true
      });

      if (lastResult.sections.some((section) => section.status === "loading")) {
        tableMissingSince = 0;
        templatePendingSince = 0;
        const summary = summarizeParseWaiting(lastResult.sections, options.templateRequirements);
        if (summary !== lastSummary) {
          options.log(`等待板块加载：${summary}`);
          lastSummary = summary;
        }
        await sleep(PARSE_RETRY_INTERVAL_MS);
        continue;
      }

      if (lastResult.sections.some((section) => section.status === "failed")) {
        return createRetryParseResult(lastResult, summarizeParseWaiting(lastResult.sections, options.templateRequirements));
      }

      if (lastResult.sections.some((section) => section.status === "no-table")) {
        templatePendingSince = 0;
        tableMissingSince ||= Date.now();
        if (Date.now() - tableMissingSince >= PANEL_TABLE_MISSING_RETRY_MS) {
          return createRetryParseResult(
            lastResult,
            `板块状态按钮已消失，但表格未正常展示：${summarizeParseWaiting(lastResult.sections, options.templateRequirements)}`
          );
        }
        const summary = summarizeParseWaiting(lastResult.sections, options.templateRequirements);
        if (summary !== lastSummary) {
          options.log(`等待板块表格：${summary}`);
          lastSummary = summary;
        }
        await sleep(PARSE_RETRY_INTERVAL_MS);
        continue;
      }

      tableMissingSince = 0;

      if (isCompleteParse(lastResult.sections, options.parseSections, options.templateRequirements)) {
        options.log(`所有板块表格与模板字段已解析完成，表格候选 ${lastResult.models.length} 个`);
        return lastResult;
      }

      const summary = summarizeParseWaiting(lastResult.sections, options.templateRequirements);
      const hasPendingFieldsOrRows = lastResult.sections.some((section) =>
        ["missing-row", "invalid-row"].includes(section.status)
      );
      if (hasPendingFieldsOrRows) {
        templatePendingSince ||= Date.now();
        if (Date.now() - templatePendingSince >= TEMPLATE_FIELD_STALE_RETRY_MS) {
          return createRetryParseResult(lastResult, `表格已展示，但目标行或模板字段长时间未完成：${summary}`);
        }
      } else {
        templatePendingSince = 0;
      }

      if (summary !== lastSummary) {
        options.log(`等待所有配置板块解析完成：${summary}`);
        lastSummary = summary;
      }

      await sleep(PARSE_RETRY_INTERVAL_MS);
    }

    return createRetryParseResult(
      lastResult,
      `等待完整解析超时：${summarizeParseWaiting(lastResult.sections, options.templateRequirements)}`
    );
  }

  function createRetryParseResult(lastResult, error) {
    return {
      ...lastResult,
      needsRetry: true,
      error
    };
  }

  function parseAllSections({ parseSections, rowTargets, rowOffsets, templateRequirements, log, silent }) {
    const models = collectTableModels();
    const sectionContexts = buildSectionContexts(parseSections);
    const parseLog = silent ? () => {} : log;

    const sections = parseSections.map((section, index) =>
      parseSection(
        {
          ...section,
          key: `t${index + 1}`,
          index: index + 1
        },
        models,
        {
          sectionContext: sectionContexts[index],
          sectionRequirements: getSectionTemplateRequirements(templateRequirements, index),
          rowTargets,
          rowOffsets,
          log: parseLog
        }
      )
    );
    const diagnostics = sections.map((section, index) =>
      buildPanelStatusDiagnostics(section, sectionContexts[index], models)
    );

    updatePanelStatusOverlay(diagnostics);

    return {
      models,
      sections,
      diagnostics
    };
  }

  function buildPanelStatusDiagnostics(section, sectionContext, models) {
    const titleRect = sectionContext?.titleNode?.getBoundingClientRect();
    const progressNodes = findSectionNodes(".n-progress", sectionContext);
    const tableWrapperNodes = findSectionNodes(".vxe-table--main-wrapper", sectionContext);
    const visibleTableWrapperCount = tableWrapperNodes.filter(isVisible).length;
    const candidates = collectSectionModels(models, sectionContext);

    return {
      index: section.index,
      title: section.title,
      status: section.status,
      ok: Boolean(section.ok),
      matched: Boolean(sectionContext?.titleNode),
      titleText: sectionContext?.titleNode ? cleanText(getVisibleText(sectionContext.titleNode)).slice(0, 120) : "",
      titleTop: Number.isFinite(titleRect?.top) ? Math.round(titleRect.top) : null,
      scopeTag: sectionContext?.scope?.tagName?.toLowerCase?.() || "",
      progressCount: progressNodes.length,
      tableWrapperCount: tableWrapperNodes.length,
      visibleTableWrapperCount,
      candidateTableCount: candidates.length,
      matchedTableIndex: section.tableIndex,
      error: section.error || ""
    };
  }

  function resetPanelStatusOverlay(parseSections) {
    panelStatusOverlayRows = parseSections.map((section, index) => ({
      index: index + 1,
      title: section.title,
      status: "pending",
      ok: false,
      matched: false,
      titleText: "",
      titleTop: null,
      scopeTag: "",
      progressCount: 0,
      tableWrapperCount: 0,
      visibleTableWrapperCount: 0,
      candidateTableCount: 0,
      matchedTableIndex: -1,
      error: "等待开始判断"
    }));
    panelStatusOverlayLog = [];
    panelStatusOverlayLastFingerprint = "";
    panelStatusOverlayHidden = false;
    renderPanelStatusOverlay();
  }

  function updatePanelStatusOverlay(rows) {
    if (!Array.isArray(rows)) {
      return;
    }

    panelStatusOverlayRows = rows;
    const fingerprint = rows
      .map((row) =>
        [
          row.index,
          row.status,
          row.ok ? "ok" : "wait",
          row.matched ? "matched" : "unmatched",
          row.progressCount,
          row.visibleTableWrapperCount,
          row.candidateTableCount,
          row.matchedTableIndex,
          row.error
        ].join("|")
      )
      .join(";");

    if (fingerprint && fingerprint !== panelStatusOverlayLastFingerprint) {
      panelStatusOverlayLastFingerprint = fingerprint;
      addPanelStatusOverlayLog(
        rows
          .map((row) => `${row.title}:${panelStatusLabel(row)}`)
          .join("；"),
        false
      );
    }

    renderPanelStatusOverlay();
  }

  function addPanelStatusOverlayLog(text, shouldRender = true) {
    const line = cleanText(text);
    if (!line) {
      return;
    }

    panelStatusOverlayLog.unshift({
      time: new Date().toLocaleTimeString("zh-CN", {
        hour12: false
      }),
      text: line
    });
    panelStatusOverlayLog = panelStatusOverlayLog.slice(0, PANEL_STATUS_LOG_LIMIT);

    if (shouldRender) {
      renderPanelStatusOverlay();
    }
  }

  function panelStatusLabel(row) {
    if (row.ok) {
      return "解析完成";
    }
    if (!row.matched) {
      return "等待关键词匹配";
    }
    if (row.tableWrapperCount > 0) {
      return `表格已展示 候选=${row.candidateTableCount}`;
    }
    if (row.progressCount > 0) {
      return `加载中 n-progress=${row.progressCount}`;
    }
    return row.error || row.status || "等待";
  }

  function renderPanelStatusOverlay() {
    if (panelStatusOverlayHidden || !document.documentElement) {
      return;
    }

    const overlay = ensurePanelStatusOverlay();
    if (!overlay) {
      return;
    }

    const body = overlay.shadowRoot.querySelector("[data-role='body']");
    const rows = overlay.shadowRoot.querySelector("[data-role='rows']");
    const logs = overlay.shadowRoot.querySelector("[data-role='logs']");
    const summary = overlay.shadowRoot.querySelector("[data-role='summary']");

    if (!body || !rows || !logs || !summary) {
      return;
    }

    const completedCount = panelStatusOverlayRows.filter((row) => row.ok).length;
    summary.textContent = `${completedCount}/${panelStatusOverlayRows.length} 完成`;
    rows.textContent = "";
    panelStatusOverlayRows.forEach((row) => rows.append(createPanelStatusRow(row)));

    logs.textContent = "";
    panelStatusOverlayLog.forEach((item) => {
      const node = document.createElement("div");
      node.className = "log-line";
      node.textContent = `${item.time} ${item.text}`;
      logs.append(node);
    });

    body.hidden = overlay.dataset.collapsed === "true";
  }

  function ensurePanelStatusOverlay() {
    let overlay = document.getElementById(PANEL_STATUS_OVERLAY_ID);
    if (overlay?.shadowRoot) {
      return overlay;
    }

    overlay = document.createElement("div");
    overlay.id = PANEL_STATUS_OVERLAY_ID;
    overlay.dataset.collapsed = "false";
    const shadow = overlay.attachShadow({
      mode: "open"
    });

    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          right: 14px;
          bottom: 14px;
          z-index: 2147483647;
          width: min(520px, calc(100vw - 28px));
          color: #1f2937;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 12px;
          line-height: 1.45;
        }
        .panel {
          overflow: hidden;
          border: 1px solid rgba(15, 23, 42, 0.16);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.96);
          box-shadow: 0 14px 36px rgba(15, 23, 42, 0.22);
          backdrop-filter: blur(8px);
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 9px 10px;
          border-bottom: 1px solid rgba(15, 23, 42, 0.1);
          background: #0f172a;
          color: #ffffff;
        }
        .title {
          display: flex;
          align-items: baseline;
          gap: 8px;
          min-width: 0;
          font-weight: 700;
        }
        .summary {
          color: rgba(255, 255, 255, 0.72);
          font-weight: 500;
        }
        .actions {
          display: flex;
          gap: 6px;
          flex: 0 0 auto;
        }
        button {
          width: 24px;
          height: 24px;
          border: 1px solid rgba(255, 255, 255, 0.24);
          border-radius: 6px;
          background: rgba(255, 255, 255, 0.12);
          color: #ffffff;
          cursor: pointer;
          font: inherit;
          line-height: 1;
        }
        .body {
          max-height: min(520px, calc(100vh - 120px));
          overflow: auto;
          padding: 10px;
        }
        .rows {
          display: grid;
          gap: 8px;
        }
        .row {
          display: grid;
          grid-template-columns: minmax(92px, 0.85fr) minmax(150px, 1.2fr);
          gap: 8px 10px;
          padding: 8px;
          border: 1px solid rgba(15, 23, 42, 0.1);
          border-radius: 7px;
          background: #ffffff;
        }
        .row[data-state="ready"] {
          border-color: rgba(22, 163, 74, 0.36);
          background: #f0fdf4;
        }
        .row[data-state="loading"] {
          border-color: rgba(37, 99, 235, 0.3);
          background: #eff6ff;
        }
        .row[data-state="failed"] {
          border-color: rgba(220, 38, 38, 0.32);
          background: #fef2f2;
        }
        .name {
          min-width: 0;
          font-weight: 700;
          color: #111827;
          overflow-wrap: anywhere;
        }
        .state {
          color: #374151;
          overflow-wrap: anywhere;
        }
        .meta {
          grid-column: 1 / -1;
          color: #4b5563;
          overflow-wrap: anywhere;
        }
        .logs-title {
          margin: 10px 0 6px;
          color: #111827;
          font-weight: 700;
        }
        .logs {
          display: grid;
          gap: 5px;
          max-height: 180px;
          overflow: auto;
          padding: 8px;
          border-radius: 7px;
          background: #111827;
          color: #e5e7eb;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
      </style>
      <div class="panel">
        <div class="header">
          <div class="title">
            <span>面板判断状态</span>
            <span class="summary" data-role="summary">0/0 完成</span>
          </div>
          <div class="actions">
            <button type="button" data-action="toggle" title="折叠/展开">-</button>
            <button type="button" data-action="close" title="关闭">x</button>
          </div>
        </div>
        <div class="body" data-role="body">
          <div class="rows" data-role="rows"></div>
          <div class="logs-title">日志</div>
          <div class="logs" data-role="logs"></div>
        </div>
      </div>
    `;

    shadow.querySelector("[data-action='toggle']").addEventListener("click", () => {
      overlay.dataset.collapsed = overlay.dataset.collapsed === "true" ? "false" : "true";
      renderPanelStatusOverlay();
    });
    shadow.querySelector("[data-action='close']").addEventListener("click", () => {
      panelStatusOverlayHidden = true;
      overlay.remove();
    });

    document.documentElement.append(overlay);
    return overlay;
  }

  function createPanelStatusRow(row) {
    const node = document.createElement("div");
    node.className = "row";
    node.dataset.state = row.ok ? "ready" : row.status || "pending";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `[t${row.index}] ${row.title}`;

    const state = document.createElement("div");
    state.className = "state";
    state.textContent = panelStatusLabel(row);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [
      `关键词:${row.matched ? "已匹配" : "未匹配"}`,
      `进度:${row.progressCount}`,
      `wrapper:${row.visibleTableWrapperCount}/${row.tableWrapperCount}`,
      `候选表格:${row.candidateTableCount}`,
      `命中表格:${row.matchedTableIndex >= 0 ? `#${row.matchedTableIndex}` : "-"}`,
      row.titleTop === null ? "" : `top:${row.titleTop}`,
      row.scopeTag ? `scope:${row.scopeTag}` : "",
      row.titleText ? `标题:${row.titleText}` : "",
      row.error ? `原因:${row.error}` : ""
    ]
      .filter(Boolean)
      .join(" | ");

    node.append(name, state, meta);
    return node;
  }

  function isCompleteParse(sections, parseSections, templateRequirements) {
    return (
      Array.isArray(sections) &&
      sections.length === parseSections.length &&
      sections.every((section) => section.ok)
    );
  }

  function summarizeParseWaiting(sections, templateRequirements) {
    if (!Array.isArray(sections) || !sections.length) {
      return "尚未解析到配置板块";
    }

    return sections
      .map((section) => {
        if (section.ok) {
          return `${section.title}:完成`;
        }
        return `${section.title}:${section.error || section.status || "等待"}`;
      })
      .join("；");
  }

  function buildSectionContexts(parseSections) {
    const contexts = parseSections.map((section) => {
      const titleNode = chooseSectionTitleNode(section.title);
      if (!titleNode) {
        return {
          title: section.title,
          titleNode: null,
          scope: null,
          band: null
        };
      }

      const rect = titleNode.getBoundingClientRect();
      return {
        title: section.title,
        titleNode,
        scope: null,
        band: {
          top: rect.top - 16,
          bottom: Infinity
        }
      };
    });

    const titleTops = contexts
      .map((context) => context.band?.top)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    contexts.forEach((context) => {
      if (!context.titleNode || !context.band) {
        return;
      }
      const titleRect = context.titleNode.getBoundingClientRect();
      const nextTop = titleTops.find((top) => top > titleRect.top + 8) ?? titleRect.top + 1400;
      context.band.bottom = nextTop - 8;
      context.scope = findSectionScope(context.titleNode, context.band);
    });

    return contexts;
  }

  function chooseSectionTitleNode(title) {
    return findTitleNodes(title)
      .map((node) => ({
        node,
        rect: node.getBoundingClientRect(),
        text: cleanText(getVisibleText(node))
      }))
      .filter((item) => Number.isFinite(item.rect.top))
      .sort((a, b) => {
        const exactA = a.text === title ? 0 : 1;
        const exactB = b.text === title ? 0 : 1;
        if (exactA !== exactB) {
          return exactA - exactB;
        }
        if (a.rect.top !== b.rect.top) {
          return a.rect.top - b.rect.top;
        }
        return a.text.length - b.text.length;
      })[0]?.node || null;
  }

  function findSectionScope(titleNode, band) {
    const titleRect = titleNode.getBoundingClientRect();
    let node = titleNode.parentElement;

    for (let depth = 0; depth < 8 && node && node !== document.body; depth += 1) {
      const rect = node.getBoundingClientRect();
      const extendsBelowTitle = rect.bottom >= titleRect.bottom + 80;
      const insideBand = rect.top <= titleRect.top + 8 && rect.top >= band.top - 80 && rect.bottom <= band.bottom + 160;
      if (insideBand && rect.width >= 240 && extendsBelowTitle) {
        return node;
      }
      node = node.parentElement;
    }

    return titleNode.parentElement || titleNode;
  }

  function collectSectionModels(models, sectionContext) {
    return models.filter((model) => isModelInSectionContext(model, sectionContext));
  }

  function isModelInSectionContext(model, sectionContext) {
    if (!model?.root || !sectionContext?.band) {
      return false;
    }

    if (sectionContext.scope?.contains(model.root)) {
      return true;
    }

    const rect = model.root.getBoundingClientRect();
    return rect.bottom >= sectionContext.band.top && rect.top <= sectionContext.band.bottom;
  }

  function inspectSectionPanelState(sectionContext) {
    if (!sectionContext?.titleNode) {
      return {
        status: "loading",
        error: "等待匹配预设面板关键词"
      };
    }

    if (hasSectionTableWrapper(sectionContext)) {
      return {
        status: "ready",
        error: ""
      };
    }

    const progressNodes = findSectionNodes(".n-progress", sectionContext);
    if (progressNodes.length) {
      return {
        status: "loading",
        error: `面板仍在加载中，n-progress=${progressNodes.length}`
      };
    }

    return {
      status: "failed",
      error: "面板加载结束但未展示 vxe-table--main-wrapper"
    };
  }

  function hasSectionTableWrapper(sectionContext) {
    return findSectionNodes(".vxe-table--main-wrapper", sectionContext).length > 0;
  }

  function findSectionNodes(selector, sectionContext) {
    if (!sectionContext?.band) {
      return [];
    }

    return Array.from(document.querySelectorAll(selector)).filter((node) =>
      isNodeInSectionContext(node, sectionContext)
    );
  }

  function isNodeInSectionContext(node, sectionContext) {
    if (!sectionContext?.band) {
      return false;
    }

    if (sectionContext.scope?.contains(node)) {
      return true;
    }

    const rect = node.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    return centerY >= sectionContext.band.top && centerY <= sectionContext.band.bottom;
  }

  function normalizeTemplateRequirements(value) {
    return {
      cells: normalizeTemplateRequirementList(value?.cells, true),
      headers: normalizeTemplateRequirementList(value?.headers, false)
    };
  }

  function normalizeTemplateRequirementList(value, includeRowOffset) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => ({
        sectionIndex: Number(item?.sectionIndex),
        rowOffset: includeRowOffset ? Number(item?.rowOffset) : 0,
        columnIndex: Number(item?.columnIndex)
      }))
      .filter(
        (item) =>
          Number.isInteger(item.sectionIndex) &&
          item.sectionIndex >= 0 &&
          Number.isInteger(item.columnIndex) &&
          item.columnIndex >= 0 &&
          (!includeRowOffset || Number.isInteger(item.rowOffset))
      );
  }

  function getSectionTemplateRequirements(templateRequirements, sectionIndex) {
    return {
      cells: (templateRequirements?.cells || []).filter((item) => item.sectionIndex === sectionIndex),
      headers: (templateRequirements?.headers || []).filter((item) => item.sectionIndex === sectionIndex)
    };
  }

  function validateSectionRows({ headers, rows, rowOffsets, requirements }) {
    const sectionLike = {
      headers,
      rows
    };
    const problems = [];

    rowOffsets.forEach((offset) => {
      const row = rows[String(offset)];
      if (!row) {
        problems.push(`缺少 r${offset}`);
        return;
      }

      const dataCells = getTemplateCells(sectionLike, String(offset));
      if (dataCells.filter(isValidDataCell).length < 2) {
        problems.push(`r${offset} 行数据无效`);
      }
    });

    (requirements?.headers || []).forEach((requirement) => {
      const value = getTemplateHeaders(sectionLike)[requirement.columnIndex];
      if (!isValidHeaderCell(value)) {
        problems.push(`h${requirement.columnIndex + 1} 无效`);
      }
    });

    (requirements?.cells || []).forEach((requirement) => {
      const value = getTemplateCells(sectionLike, String(requirement.rowOffset))[requirement.columnIndex];
      if (!isValidDataCell(value)) {
        problems.push(`r${requirement.rowOffset},c${requirement.columnIndex + 1} 无效`);
      }
    });

    return {
      ok: problems.length === 0,
      error: problems.join("；")
    };
  }

  function isValidHeaderCell(value) {
    return Boolean(cleanText(value));
  }

  function isValidDataCell(value) {
    return !isReplaceableCellText(value);
  }

  function getTemplateHeaders(section) {
    const headers = Array.isArray(section?.headers) ? section.headers : [];
    return headers.slice(getLeadingDimensionColumnCount(section));
  }

  function getTemplateCells(section, rowOffset) {
    const cells = Array.isArray(section?.rows?.[rowOffset]?.cells) ? section.rows[rowOffset].cells : [];
    return cells.slice(getLeadingDimensionColumnCount(section));
  }

  function getLeadingDimensionColumnCount(section) {
    const headers = Array.isArray(section?.headers) ? section.headers : [];
    const firstHeader = cleanText(headers[0]);
    if (DATE_HEADER_PATTERN.test(firstHeader)) {
      return 1;
    }

    const rows = Object.values(section?.rows || {});
    if (rows.some((row) => DATE_CELL_PATTERN.test(cleanText(row?.cells?.[0])))) {
      return 1;
    }

    return 0;
  }

  function findProjectCode() {
    const pattern = /sonic_T([^\s"'<>-]{4})-[^\s"'<>]*/;
    const sources = [
      location.href,
      document.title,
      document.body?.innerText || "",
      document.documentElement?.textContent || "",
      document.documentElement?.outerHTML || ""
    ];

    for (const source of sources) {
      const match = pattern.exec(source);
      if (match) {
        return {
          code: match[1],
          fullMatch: match[0].slice(0, 160)
        };
      }
    }

    return {
      code: "",
      fullMatch: ""
    };
  }

  function parseSection(section, models, context) {
    const sectionContext = context.sectionContext || {};
    const candidates = collectSectionModels(models, sectionContext);
    const debugPrefix = `[${section.title}]`;
    context.log(`${debugPrefix} 候选表格 ${candidates.length} 个`);
    const panelState = inspectSectionPanelState(sectionContext);

    if (panelState.status !== "ready") {
      return createSectionResult({
        section,
        status: panelState.status,
        panelLoaded: false,
        tableIndex: -1,
        headers: [],
        rows: {},
        error: panelState.error
      });
    }

    const matches = [];

    for (const model of candidates) {
      const rows = {};
      const missingOffsets = [];

      for (const offset of context.rowOffsets) {
        const target = context.rowTargets[String(offset)];
        const row = findTargetRow(model, target.label, target.dateText);
        if (row) {
          rows[String(offset)] = {
            offset,
            dateText: target.dateText,
            label: target.label,
            rowText: row.text,
            top: row.top,
            rowIndex: row.rowIndex,
            cells: row.cells
          };
        } else {
          missingOffsets.push(offset);
        }
      }

      if (!Object.keys(rows).length) {
        continue;
      }

      const validation = validateSectionRows({
        section,
        headers: model.headers,
        rows,
        rowOffsets: context.rowOffsets,
        requirements: context.sectionRequirements
      });

      matches.push({
        model,
        rows,
        missingOffsets,
        validation,
        score: scoreSectionMatch(model, rows, missingOffsets, validation)
      });
    }

    if (matches.length) {
      matches.sort((a, b) => b.score - a.score);
      const bestMatch = matches[0];

      context.log(`${debugPrefix} 命中表格 #${bestMatch.model.index}`, {
        headers: bestMatch.model.headers,
        rows: bestMatch.rows,
        validation: bestMatch.validation
      });

      const status = bestMatch.validation.ok
        ? "ready"
        : bestMatch.missingOffsets.length
          ? "missing-row"
          : "invalid-row";

      return {
        ok: bestMatch.validation.ok,
        key: section.key,
        index: section.index,
        title: section.title,
        status,
        panelLoaded: true,
        tableIndex: bestMatch.model.index,
        headers: bestMatch.model.headers,
        rows: bestMatch.rows,
        error: bestMatch.validation.error
      };
    }

    const fallback = candidates.slice(0, 3).map((model) => ({
      tableIndex: model.index,
      headers: model.headers,
      rowCount: model.rows.length,
      sampleRows: model.rows.slice(0, 3).map((row) => row.cells)
    }));

    context.log(`${debugPrefix} 未找到目标日期行`, fallback);
    return createSectionResult({
      section,
      status: "missing-row",
      panelLoaded: true,
      tableIndex: -1,
      headers: [],
      rows: {},
      error: `未找到配置目标行：${context.rowOffsets.map((offset) => `r${offset}`).join("、")}`
    });
  }

  function createSectionResult({ section, status, panelLoaded, tableIndex, headers, rows, error }) {
    return {
      ok: false,
      key: section.key,
      index: section.index,
      title: section.title,
      status,
      panelLoaded,
      tableIndex,
      headers,
      rows,
      error
    };
  }

  function scoreSectionMatch(model, rows, missingOffsets, validation) {
    const headerCount = Array.isArray(model.headers) ? model.headers.filter(Boolean).length : 0;
    const cells = Object.values(rows).flatMap((row) => row.cells || []);
    const realCellCount = cells.filter((cell) => cell && !isPlaceholderCellText(cell)).length;
    const placeholderCount = cells.filter(isPlaceholderCellText).length;
    const rowCoverage = Object.values(rows).reduce((sum, row) => {
      const cellCount = Array.isArray(row.cells) ? row.cells.length : 0;
      return sum + Math.min(cellCount, headerCount || cellCount);
    }, 0);

    return (
      (validation?.ok ? 2000 : 0) +
      (missingOffsets.length ? 0 : 1000) +
      headerCount * 20 +
      realCellCount * 4 +
      rowCoverage * 2 -
      placeholderCount * 15 -
      missingOffsets.length * 100
    );
  }

  function collectTableModels() {
    const roots = new Set();
    const selectors = [
      ".ant-table",
      ".el-table",
      ".vxe-table",
      ".vxe-table--main-wrapper",
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
    const headerInfos = buildHeaderInfos(headerRows);
    const headers = normalizeHeaders(buildHeaders(headerRows), headerInfos);
    const rows = buildBodyRowModels(bodyRows, headers, headerInfos);

    return {
      index,
      root,
      headers,
      headerInfos,
      rows
    };
  }

  function buildBodyRowModels(bodyRows, headers, headerInfos) {
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
      .forEach((group, rowIndex) => {
        const cellInfos = dedupeCellInfos(group.parts.flatMap((part) => part.cells)).sort(
          (a, b) => a.left - b.left
        );
        const cells = alignCellsToHeaders(cellInfos, headers, headerInfos);
        const rowText = cells.join(" | ");
        if (seen.has(rowText)) {
          return;
        }
        seen.add(rowText);
        rows.push({
          node: group.parts[0].node,
          top: group.top,
          rowIndex,
          cellInfos,
          cells,
          text: rowText
        });
      });

    return rows;
  }

  function alignCellsToHeaders(cellInfos, headers, headerInfos) {
    const rawCells = cellInfos.map((cell) => cell.text);
    const headerColumns = getHeaderColumns(headers, headerInfos);
    if (!headerColumns.length || rawCells.length <= headerColumns.length) {
      return rawCells;
    }

    const usedIndexes = new Set();
    const aligned = headerColumns.map((header) => {
      const candidates = cellInfos
        .map((cell, index) => ({
          cell,
          index,
          distance: Math.abs(cell.centerX - header.centerX)
        }))
        .filter((candidate) => !usedIndexes.has(candidate.index))
        .sort((a, b) => a.distance - b.distance);

      const tolerance = Math.max(40, header.width * 0.9);
      const nearCandidates = candidates.filter((candidate) => candidate.distance <= tolerance);
      const best =
        nearCandidates.find((candidate) => !isPlaceholderCellText(candidate.cell.text)) ||
        nearCandidates[0];

      if (!best) {
        return "";
      }

      usedIndexes.add(best.index);
      return best.cell.text;
    });

    const filledCount = aligned.filter(Boolean).length;
    return filledCount >= Math.min(headerColumns.length, rawCells.length) - 1 ? aligned : rawCells;
  }

  function isPlaceholderCellText(value) {
    return /^[-–—\s]+$/.test(String(value || ""));
  }

  function isReplaceableCellText(value) {
    return !cleanText(value) || isPlaceholderCellText(value);
  }

  function getHeaderColumns(headers, headerInfos) {
    if (!Array.isArray(headers) || !headers.length || !Array.isArray(headerInfos) || !headerInfos.length) {
      return [];
    }

    const uniqueHeaderInfos = dedupeHeaderInfos(headerInfos).sort((a, b) => a.left - b.left);
    if (uniqueHeaderInfos.length < headers.filter(Boolean).length) {
      return [];
    }

    return headers.map((header, index) => {
      const headerInfo = uniqueHeaderInfos[index];
      return {
        text: header || headerInfo?.text || "",
        left: headerInfo?.left ?? 0,
        width: headerInfo?.width || 80,
        centerX: headerInfo?.centerX ?? 0
      };
    });
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

    const headerRowModels = buildHeaderRowModels(headerRows);
    const grid = [];
    headerRowModels.forEach((cells, rowIndex) => {
      grid[rowIndex] ||= [];
      let columnIndex = 0;
      cells.forEach((cell) => {
        while (grid[rowIndex][columnIndex]) {
          columnIndex += 1;
        }

        for (let r = 0; r < cell.rowSpan; r += 1) {
          for (let c = 0; c < cell.colSpan; c += 1) {
            grid[rowIndex + r] ||= [];
            grid[rowIndex + r][columnIndex + c] = cell.text;
          }
        }
        columnIndex += cell.colSpan;
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

  function buildHeaderRowModels(headerRows) {
    const groups = [];

    headerRows.forEach((row) => {
      const rect = row.getBoundingClientRect();
      let group = groups.find((item) => Math.abs(item.top - rect.top) <= 3);
      if (!group) {
        group = {
          top: rect.top,
          cells: []
        };
        groups.push(group);
      }

      group.cells.push(...collectCells(row).map(headerCellToInfo).filter((cell) => cell.text));
    });

    return groups
      .sort((a, b) => a.top - b.top)
      .map((group) => dedupeHeaderInfos(group.cells).sort((a, b) => a.left - b.left));
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

  function normalizeHeaders(headers, headerInfos) {
    const usefulHeaders = headers.filter(Boolean);
    if (usefulHeaders.length) {
      return headers;
    }

    return headerInfos
      .filter((header, index, source) => {
        const sameTextBefore = source.findIndex((item) => item.text === header.text);
        return sameTextBefore === index;
      })
      .map((header) => header.text);
  }

  function findTitleNodes(title) {
    const candidates = Array.from(
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

    const precise = candidates.filter((node) => {
      const text = cleanText(getVisibleText(node));
      return text === title || (text.startsWith(title) && text.length <= title.length + 20);
    });

    return precise.length ? precise : candidates;
  }

  function findTargetRow(model, targetDateLabel, targetDateText) {
    return model.rows.find((row) => row.text.includes(targetDateLabel)) ||
      model.rows.find((row) => row.text.includes(targetDateText));
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

  function headerCellToInfo(cell) {
    return {
      ...cellToInfo(cell),
      colSpan: Number(cell.getAttribute("colspan") || cell.colSpan || 1),
      rowSpan: Number(cell.getAttribute("rowspan") || cell.rowSpan || 1)
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

  function dedupeHeaderInfos(cells) {
    const seen = new Set();
    return cells.filter((cell) => {
      const key = `${Math.round(cell.left)}:${cell.text}`;
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

  function normalizeParseSections(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((section, index) => ({
        id: section.id || `section-${index + 1}`,
        title: cleanText(section.title || section.name || "")
      }))
      .filter((section) => section.title);
  }

  function normalizeRowOffsets(value) {
    const offsets = Array.isArray(value) ? value : DEFAULT_ROW_OFFSETS;
    const normalized = Array.from(
      new Set(
        offsets
          .map((offset) => Number(offset))
          .filter((offset) => Number.isFinite(offset))
      )
    );

    return normalized.length ? normalized : DEFAULT_ROW_OFFSETS;
  }

  function getDateByOffset(offset) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
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
