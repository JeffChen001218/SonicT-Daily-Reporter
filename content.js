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
  const VXE_TABLE_WRAPPER_SELECTOR = "[class*='vxe-table--main-wrapper'],[class*='vxe-table--render-wrapper'],[class*='vxe-table--fixed-left-wrapper'],[class*='vxe-table--fixed-right-wrapper']";
  const PANEL_STATUS_OVERLAY_ID = "__sonic_daily_panel_status_overlay__";
  const PANEL_STATUS_LOG_LIMIT = 12;
  const TABLE_SCROLL_RENDER_DELAY_MS = 120;
  const TABLE_SCROLL_STEP_RATIO = 0.72;
  const TABLE_SCROLL_MAX_X_STEPS = 28;
  const TABLE_SCROLL_MAX_Y_STEPS = 36;
  const TABLE_COLUMN_MERGE_TOLERANCE_PX = 14;
  const TABLE_ROW_MERGE_TOLERANCE_PX = 6;
  const TABLE_ROW_VIEWPORT_MERGE_TOLERANCE_PX = 8;
  const SECTION_LAZY_SCROLL_WAIT_MS = 700;
  const SECTION_LAZY_SCROLL_ATTEMPTS = 4;
  const SECTION_DISCOVERY_SCROLL_WAIT_MS = 650;
  const SECTION_DISCOVERY_SCROLL_MAX_STEPS = 18;
  const DATA_TABLE_VIEW_LABEL = "数据表";
  const VIEW_MODE_LABELS = ["趋势图", "堆积图", "累计图", "分布图", "饼状图", DATA_TABLE_VIEW_LABEL];
  const DATA_TABLE_VIEW_SWITCH_WAIT_MS = 450;
  const DATA_TABLE_VIEW_TABLE_WAIT_MS = 2500;

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
        const weekdayLabel = WEEKDAYS[date.getDay()];
        return [
          String(offset),
          {
            offset,
            dateText,
            weekdayLabel,
            label: `${dateText}(${weekdayLabel})`,
            candidates: [
              `${dateText}(${weekdayLabel})`,
              `${dateText}（${weekdayLabel}）`,
              dateText
            ]
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
    log(`目标行 ${Object.values(rowTargets).map((target) => `${formatRowOffset(target.offset)}:${target.label}`).join("、")}`);
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
    let lastResult = {
      models: [],
      sections: [],
      diagnostics: []
    };
    let lastSummary = "";
    let tableMissingSince = 0;
    let templatePendingSince = 0;

    while (Date.now() - startedAt < options.timeoutMs) {
      throwIfStopped();
      lastResult = await parseAllSections({
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

  async function parseAllSections({ parseSections, rowTargets, rowOffsets, templateRequirements, log, silent }) {
    const sectionContexts = await buildSectionContexts(parseSections);
    const parseLog = silent ? () => {} : log;
    let nextModelIndex = 0;
    const sectionModelGroups = [];

    for (let index = 0; index < sectionContexts.length; index += 1) {
      const sectionContext = sectionContexts[index];
      const sectionRequirements = getSectionTemplateRequirements(templateRequirements, index);
      const required = isTemplateSectionRequired(templateRequirements, index);
      const sectionRowOffsets = getSectionRowOffsets(rowOffsets, sectionRequirements, required, templateRequirements);

      if (!required) {
        sectionModelGroups.push([]);
        continue;
      }

      await activateSectionLazyLoad(sectionContext);
      await ensureSectionDataTableView(sectionContext, parseLog);
      const models = await collectSectionTableModels(sectionContext, () => nextModelIndex++, {
        targetGroups: getTargetGroupsForRowOffsets(rowTargets, sectionRowOffsets)
      });
      sectionModelGroups.push(models);
    }

    const models = sectionModelGroups.flat();

    const sections = parseSections.map((section, index) => {
      const sectionRequirements = getSectionTemplateRequirements(templateRequirements, index);
      const required = isTemplateSectionRequired(templateRequirements, index);
      const sectionInfo = {
        ...section,
        key: `t${index + 1}`,
        index: index + 1
      };

      if (!required) {
        return createSkippedSectionResult(sectionInfo);
      }

      return parseSection(
        {
          ...sectionInfo
        },
        sectionModelGroups[index],
        {
          sectionContext: sectionContexts[index],
          sectionRequirements,
          rowTargets,
          rowOffsets: getSectionRowOffsets(rowOffsets, sectionRequirements, required, templateRequirements),
          log: parseLog
        }
      );
    });
    const diagnostics = sections.map((section, index) =>
      buildPanelStatusDiagnostics(section, sectionContexts[index], sectionModelGroups[index])
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
    const tableWrapperNodes = findSectionTableWrappers(sectionContext);
    const visibleTableWrapperCount = tableWrapperNodes.filter(isVisible).length;
    const tableWrapperTops = tableWrapperNodes.map((node) => Math.round(node.getBoundingClientRect().top)).join(",");
    const candidates = models || [];
    const scopeClass = cleanText(sectionContext?.scope?.className || "").slice(0, 80);
    const refreshButtonCount = findSectionRefreshButtons(sectionContext).length;

    return {
      index: section.index,
      title: section.title,
      status: section.status,
      ok: Boolean(section.ok),
      matched: Boolean(sectionContext?.titleNode),
      titleText: sectionContext?.titleNode ? cleanText(getVisibleText(sectionContext.titleNode)).slice(0, 120) : "",
      titleTop: Number.isFinite(titleRect?.top) ? Math.round(titleRect.top) : null,
      scopeTag: sectionContext?.scope?.tagName?.toLowerCase?.() || "",
      scopeClass,
      refreshButtonCount,
      progressCount: progressNodes.length,
      tableWrapperCount: tableWrapperNodes.length,
      visibleTableWrapperCount,
      tableWrapperTops,
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
      scopeClass: "",
      refreshButtonCount: 0,
      progressCount: 0,
      tableWrapperCount: 0,
      visibleTableWrapperCount: 0,
      tableWrapperTops: "",
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
          row.tableWrapperTops,
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
      `刷新按钮:${row.refreshButtonCount || 0}`,
      `进度:${row.progressCount}`,
      `wrapper:${row.visibleTableWrapperCount}/${row.tableWrapperCount}`,
      row.tableWrapperTops ? `wrapperTop:${row.tableWrapperTops}` : "",
      `候选表格:${row.candidateTableCount}`,
      `命中表格:${row.matchedTableIndex >= 0 ? `#${row.matchedTableIndex}` : "-"}`,
      row.titleTop === null ? "" : `top:${row.titleTop}`,
      row.scopeTag ? `scope:${row.scopeTag}` : "",
      row.scopeClass ? `scopeClass:${row.scopeClass}` : "",
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

  async function buildSectionContexts(parseSections) {
    const scrollRoot = findDashboardScrollRoot();
    const contexts = [];

    for (const section of parseSections) {
      const titleNode = await discoverSectionTitleNode(section.title, scrollRoot);
      contexts.push(createSectionContext(section.title, titleNode));
    }

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
    });

    return contexts;
  }

  function createSectionContext(title, titleNode) {
    if (!titleNode) {
      return {
        title,
        titleNode: null,
        scope: null,
        band: null
      };
    }

    const rect = titleNode.getBoundingClientRect();
    return {
      title,
      titleNode,
      scope: findPanelDataScope(titleNode),
      band: {
        top: rect.top - 16,
        bottom: Infinity
      }
    };
  }

  async function discoverSectionTitleNode(title, scrollRoot) {
    let titleNode = chooseSectionTitleNode(title);
    if (titleNode) {
      return titleNode;
    }

    const maxScrollTop = getMaxScrollTop(scrollRoot);
    const viewport = getScrollViewportHeight(scrollRoot);
    const step = Math.max(320, Math.floor(viewport * 0.72));
    const currentTop = getScrollTop(scrollRoot);
    const downwardPositions = Array.from(
      { length: SECTION_DISCOVERY_SCROLL_MAX_STEPS },
      (_item, index) => Math.min(maxScrollTop, currentTop + step * (index + 1))
    );
    const positions = uniqueNumbersInOrder([
      currentTop,
      ...downwardPositions,
      maxScrollTop,
      0
    ]);

    for (const top of positions) {
      throwIfStopped();
      setScrollTop(scrollRoot, top);
      dispatchSyntheticScrollEvents(scrollRoot);
      await sleep(SECTION_DISCOVERY_SCROLL_WAIT_MS);
      titleNode = chooseSectionTitleNode(title);
      if (titleNode) {
        return titleNode;
      }
    }

    return null;
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
        const h3A = a.node.tagName?.toLowerCase() === "h3" ? 0 : 1;
        const h3B = b.node.tagName?.toLowerCase() === "h3" ? 0 : 1;
        if (h3A !== h3B) {
          return h3A - h3B;
        }
        if (a.rect.top !== b.rect.top) {
          return a.rect.top - b.rect.top;
        }
        return a.text.length - b.text.length;
      })[0]?.node || null;
  }

  function findPanelDataScope(titleNode) {
    let node = titleNode;
    for (let depth = 0; depth < 3 && node?.parentElement; depth += 1) {
      node = node.parentElement;
    }
    return node || null;
  }

  function findDashboardScrollRoot() {
    const candidates = Array.from(document.querySelectorAll("main,section,[class*='dashboard'],[class*='canvas'],[class*='content'],[class*='scroll'],[class*='layout']"))
      .filter((node) => isScrollableOnAxis(node, "y"))
      .sort((a, b) => {
        const scoreDiff = scoreDashboardScrollRoot(b) - scoreDashboardScrollRoot(a);
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return getScrollOverflow(b, "y") - getScrollOverflow(a, "y");
      });

    return candidates[0] || document.scrollingElement || document.documentElement;
  }

  function scoreDashboardScrollRoot(node) {
    const rect = node.getBoundingClientRect();
    const className = String(node.className || "");
    let score = 0;
    if (/dashboard|canvas|content|main|scroll|layout/i.test(className)) {
      score += 20;
    }
    if (rect.width > window.innerWidth * 0.45) {
      score += 10;
    }
    if (rect.height > window.innerHeight * 0.35) {
      score += 10;
    }
    if (node.querySelector?.("[class*='vxe-table'],h3")) {
      score += 20;
    }
    return score;
  }

  function getScrollTop(node) {
    if (!node || node === document.scrollingElement || node === document.documentElement || node === document.body) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }
    return Number.isFinite(node.scrollTop) ? node.scrollTop : 0;
  }

  function setScrollTop(node, top) {
    if (!node || node === document.scrollingElement || node === document.documentElement || node === document.body) {
      window.scrollTo(window.scrollX, top);
      return;
    }
    node.scrollTop = top;
  }

  function dispatchSyntheticScrollEvents(node) {
    const event = new Event("scroll", {
      bubbles: true
    });
    if (node && node !== document.scrollingElement && node !== document.documentElement && node !== document.body) {
      node.dispatchEvent(event);
    }
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
  }

  function getMaxScrollTop(node) {
    if (!node || node === document.scrollingElement || node === document.documentElement || node === document.body) {
      const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      return Math.max(0, scrollHeight - window.innerHeight);
    }
    return Math.max(0, node.scrollHeight - node.clientHeight);
  }

  function getScrollViewportHeight(node) {
    if (!node || node === document.scrollingElement || node === document.documentElement || node === document.body) {
      return window.innerHeight || document.documentElement.clientHeight || 700;
    }
    return node.clientHeight || node.getBoundingClientRect?.().height || 700;
  }

  async function activateSectionLazyLoad(sectionContext) {
    if (!sectionContext?.titleNode) {
      return;
    }

    for (let attempt = 0; attempt < SECTION_LAZY_SCROLL_ATTEMPTS; attempt += 1) {
      throwIfStopped();
      scrollSectionIntoView(sectionContext);
      await sleep(SECTION_LAZY_SCROLL_WAIT_MS);

      if (hasSectionTableWrapper(sectionContext) || findSectionNodes(".n-progress", sectionContext).length) {
        return;
      }
    }
  }

  async function ensureSectionDataTableView(sectionContext, log) {
    if (!sectionContext?.scope || hasSectionTableWrapper(sectionContext) || hasSectionRefreshButton(sectionContext)) {
      return;
    }

    const progressNodes = findSectionNodes(".n-progress", sectionContext);
    if (progressNodes.length) {
      return;
    }

    const scopedModes = findVisibleViewModeSpans(sectionContext.scope);
    if (!scopedModes.length) {
      return;
    }

    const scopedDataTable = scopedModes.find((item) => item.text === DATA_TABLE_VIEW_LABEL);
    if (scopedDataTable && (scopedModes.length > 1 || isLikelyViewModeOption(scopedDataTable.node))) {
      log?.(`[${sectionContext.title}] 切换视图到数据表`);
      await clickViewModeNode(scopedDataTable.node);
      await waitForSectionTableWrapper(sectionContext, DATA_TABLE_VIEW_TABLE_WAIT_MS);
      return;
    }

    const currentMode = scopedModes.find((item) => item.text !== DATA_TABLE_VIEW_LABEL);
    if (!currentMode) {
      await waitForSectionTableWrapper(sectionContext, DATA_TABLE_VIEW_SWITCH_WAIT_MS);
      return;
    }

    log?.(`[${sectionContext.title}] 当前视图 ${currentMode.text}，尝试切换到数据表`);
    await clickViewModeNode(currentMode.node);
    await sleep(DATA_TABLE_VIEW_SWITCH_WAIT_MS);

    const dataTableOption = findVisibleDataTableOption(currentMode.node);
    if (!dataTableOption) {
      return;
    }

    await clickViewModeNode(dataTableOption);
    await waitForSectionTableWrapper(sectionContext, DATA_TABLE_VIEW_TABLE_WAIT_MS);
  }

  function findVisibleViewModeSpans(root) {
    if (!root) {
      return [];
    }

    return Array.from(root.querySelectorAll("span"))
      .filter((node) => !node.closest(`#${PANEL_STATUS_OVERLAY_ID}`))
      .filter(isVisible)
      .map((node) => ({
        node,
        text: cleanText(getVisibleText(node))
      }))
      .filter((item) => VIEW_MODE_LABELS.includes(item.text));
  }

  function findVisibleDataTableOption(triggerNode) {
    const triggerRect = triggerNode?.getBoundingClientRect?.();
    const candidates = Array.from(document.querySelectorAll("span"))
      .filter((node) => !node.closest(`#${PANEL_STATUS_OVERLAY_ID}`))
      .filter((node) => node !== triggerNode)
      .filter(isVisible)
      .filter((node) => cleanText(getVisibleText(node)) === DATA_TABLE_VIEW_LABEL)
      .map((node) => ({
        node,
        score: scoreViewModeOption(node, triggerRect)
      }))
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.node || null;
  }

  function scoreViewModeOption(node, triggerRect) {
    const rect = node.getBoundingClientRect();
    let score = isLikelyViewModeOption(node) ? 100 : 0;
    if (triggerRect && Number.isFinite(triggerRect.left)) {
      const dx = Math.abs((rect.left + rect.right) / 2 - (triggerRect.left + triggerRect.right) / 2);
      const dy = Math.abs((rect.top + rect.bottom) / 2 - (triggerRect.top + triggerRect.bottom) / 2);
      score -= dx * 0.02 + dy * 0.01;
    }
    return score;
  }

  function isLikelyViewModeOption(node) {
    return Boolean(
      node.closest(
        [
          "[role='option']",
          "[role='menuitem']",
          "[role='tab']",
          ".ant-select-item-option",
          ".ant-dropdown-menu-item",
          ".el-select-dropdown__item",
          ".el-dropdown-menu__item",
          ".arco-select-option",
          ".arco-dropdown-option",
          ".semi-select-option",
          ".semi-dropdown-item",
          ".n-base-select-option",
          ".n-dropdown-option",
          ".ant-tabs-tab",
          ".el-tabs__item"
        ].join(",")
      )
    );
  }

  async function clickViewModeNode(node) {
    const target = getViewModeClickTarget(node);
    target.scrollIntoView({
      block: "center",
      inline: "nearest"
    });
    target.focus?.();
    target.click();
    await sleep(DATA_TABLE_VIEW_SWITCH_WAIT_MS);
  }

  function getViewModeClickTarget(node) {
    return node.closest(
      [
        "button",
        "[role='button']",
        "[role='option']",
        "[role='menuitem']",
        "[role='tab']",
        "[role='combobox']",
        "[aria-haspopup='listbox']",
        "[aria-haspopup='menu']",
        ".ant-select-selector",
        ".ant-select-item-option",
        ".ant-dropdown-trigger",
        ".ant-dropdown-menu-item",
        ".el-select",
        ".el-select-dropdown__item",
        ".el-dropdown",
        ".el-dropdown-menu__item",
        ".arco-select-view",
        ".arco-select-option",
        ".arco-dropdown-option",
        ".semi-select-selection",
        ".semi-select-option",
        ".semi-dropdown-item",
        ".n-base-selection",
        ".n-base-select-option",
        ".n-dropdown-option",
        ".ant-tabs-tab",
        ".el-tabs__item"
      ].join(",")
    ) || node;
  }

  async function waitForSectionTableWrapper(sectionContext, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      throwIfStopped();
      if (hasSectionTableWrapper(sectionContext)) {
        return true;
      }
      await sleep(150);
    }
    return hasSectionTableWrapper(sectionContext);
  }

  function scrollSectionIntoView(sectionContext) {
    const target = sectionContext.scope || sectionContext.titleNode;
    target.scrollIntoView({
      block: "center",
      inline: "nearest"
    });

    const scrollParent = findScrollableParent(target);
    if (scrollParent && scrollParent !== document.scrollingElement) {
      const rect = target.getBoundingClientRect();
      const parentRect = scrollParent.getBoundingClientRect();
      scrollParent.scrollTop += rect.top - parentRect.top - Math.max(40, parentRect.height * 0.18);
    }
  }

  function findScrollableParent(node) {
    let current = node?.parentElement;
    while (current && current !== document.body && current !== document.documentElement) {
      if (isScrollableOnAxis(current, "y")) {
        return current;
      }
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function inspectSectionPanelState(sectionContext) {
    if (!sectionContext?.titleNode) {
      return {
        status: "loading",
        error: "等待匹配预设面板关键词"
      };
    }

    if (hasSectionRefreshButton(sectionContext)) {
      return {
        status: "failed",
        error: "面板出现刷新按钮，需要刷新网页重新加载"
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
      error: "面板加载结束但未展示数据表"
    };
  }

  function hasSectionTableWrapper(sectionContext) {
    return findSectionTableWrappers(sectionContext).length > 0;
  }

  function hasSectionRefreshButton(sectionContext) {
    return findSectionRefreshButtons(sectionContext).length > 0;
  }

  function findSectionRefreshButtons(sectionContext) {
    return findSectionNodes(
      [
        "button",
        "input[type='button']",
        "input[type='submit']",
        "[role='button']",
        ".ant-btn",
        ".el-button",
        ".arco-btn",
        ".semi-button"
      ].join(","),
      sectionContext
    )
      .filter(isVisible)
      .filter((node) => getButtonText(node).replace(/\s+/g, "") === "刷新");
  }

  async function collectSectionTableModels(sectionContext, nextIndex, options = {}) {
    const models = [];
    const roots = uniqueNodes(
      findSectionTableWrappers(sectionContext)
        .map(getTableModelRoot)
        .filter(Boolean)
    )
      .filter(isVisible)
      .filter((root) => !root.closest(`#${PANEL_STATUS_OVERLAY_ID}`));

    for (const root of roots) {
      throwIfStopped();
      const model = await buildTableModel(root, nextIndex(), sectionContext, options);
      if (model.rows.length) {
        models.push(model);
      }
    }

    return models;
  }

  function findSectionTableWrappers(sectionContext) {
    if (!sectionContext?.scope) {
      return [];
    }

    return Array.from(sectionContext.scope.querySelectorAll(VXE_TABLE_WRAPPER_SELECTOR));
  }

  function getTableModelRoot(node) {
    return node?.closest?.(".vxe-table") ||
      node?.closest?.("[class*='vxe-table']") ||
      node;
  }

  function findSectionNodes(selector, sectionContext) {
    if (!sectionContext?.scope) {
      return [];
    }

    return Array.from(sectionContext.scope.querySelectorAll(selector));
  }

  function normalizeTemplateRequirements(value) {
    const cells = normalizeTemplateRequirementList(value?.cells, true);
    const headers = normalizeTemplateRequirementList(value?.headers, false);
    return {
      cells,
      headers,
      sectionIndexes: normalizeTemplateSectionIndexes(value?.sectionIndexes, cells, headers)
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

  function normalizeTemplateSectionIndexes(value, cells, headers) {
    const indexes = Array.isArray(value)
      ? value
      : [
          ...(cells || []).map((item) => item.sectionIndex),
          ...(headers || []).map((item) => item.sectionIndex)
        ];

    return Array.from(
      new Set(
        indexes
          .map((index) => Number(index))
          .filter((index) => Number.isInteger(index) && index >= 0)
      )
    );
  }

  function getSectionTemplateRequirements(templateRequirements, sectionIndex) {
    return {
      cells: (templateRequirements?.cells || []).filter((item) => item.sectionIndex === sectionIndex),
      headers: (templateRequirements?.headers || []).filter((item) => item.sectionIndex === sectionIndex)
    };
  }

  function isTemplateSectionRequired(templateRequirements, sectionIndex) {
    const sectionIndexes = Array.isArray(templateRequirements?.sectionIndexes)
      ? templateRequirements.sectionIndexes
      : [];
    return !sectionIndexes.length || sectionIndexes.includes(sectionIndex);
  }

  function getSectionRowOffsets(fallbackRowOffsets, requirements, required, templateRequirements) {
    if (!required) {
      return [];
    }

    const offsets = Array.from(
      new Set(
        (requirements?.cells || [])
          .map((item) => Number(item.rowOffset))
          .filter((offset) => Number.isInteger(offset))
      )
    ).sort((a, b) => a - b);

    if (offsets.length) {
      return offsets;
    }

    if ((requirements?.headers || []).length) {
      return [];
    }

    if (hasTemplateSectionReferences(templateRequirements)) {
      return [];
    }

    return normalizeRowOffsets(fallbackRowOffsets);
  }

  function hasTemplateSectionReferences(templateRequirements) {
    return Array.isArray(templateRequirements?.sectionIndexes) && templateRequirements.sectionIndexes.length > 0;
  }

  function getTargetGroupsForRowOffsets(rowTargets, rowOffsets) {
    return rowOffsets
      .map((offset) => rowTargets?.[String(offset)])
      .filter(Boolean)
      .map((target) => target.candidates || [target.label, target.dateText].filter(Boolean))
      .filter((group) => group.length);
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
        problems.push(`缺少 ${formatRowOffset(offset)}`);
        return;
      }

      const dataCells = getTemplateCells(sectionLike, String(offset));
      if (!dataCells.length) {
        problems.push(`${formatRowOffset(offset)} 行无数据`);
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
        problems.push(`${formatRowOffset(requirement.rowOffset)},c${requirement.columnIndex + 1} 无效`);
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
    return Boolean(cleanText(value));
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
    if (rows.some((row) => extractDateText(row?.cells?.[0]))) {
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
    const candidates = Array.isArray(models) ? models : [];
    const sectionRowOffsets = Array.isArray(context.rowOffsets) ? context.rowOffsets : [];
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

      for (const offset of sectionRowOffsets) {
        const target = context.rowTargets[String(offset)];
        const row = findTargetRow(model, target);
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

      if (sectionRowOffsets.length && !Object.keys(rows).length) {
        continue;
      }

      const validation = validateSectionRows({
        section,
        headers: model.headers,
        rows,
        rowOffsets: sectionRowOffsets,
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
        sourceTitle: bestMatch.model.sourceTitle,
        sourceWrapperTop: bestMatch.model.sourceWrapperTop,
        headers: bestMatch.model.headers,
        rows: bestMatch.rows,
        validation: bestMatch.validation,
        scanStats: bestMatch.model.scanStats
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
        sourceTitle: bestMatch.model.sourceTitle,
        sourceWrapperTop: bestMatch.model.sourceWrapperTop,
        headers: bestMatch.model.headers,
        rows: bestMatch.rows,
        error: bestMatch.validation.error
      };
    }

    const fallback = candidates.slice(0, 3).map((model) => ({
      tableIndex: model.index,
      headers: model.headers,
      scanStats: model.scanStats,
      rowCount: model.rows.length,
      sampleRows: model.rows.slice(0, 8).map((row) => row.cells)
    }));

    context.log(`${debugPrefix} 未找到目标日期行`, fallback);
    return createSectionResult({
      section,
      status: "missing-row",
      panelLoaded: true,
      tableIndex: -1,
      headers: [],
      rows: {},
      error: sectionRowOffsets.length
        ? `未找到配置目标行：${formatRowOffsets(sectionRowOffsets)}`
        : "未找到可解析表格"
    });
  }

  function createSkippedSectionResult(section) {
    return {
      ok: true,
      key: section.key,
      index: section.index,
      title: section.title,
      status: "skipped",
      panelLoaded: false,
      tableIndex: -1,
      headers: [],
      rows: {},
      error: ""
    };
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
    const realCellCount = cells.filter((cell) => cleanText(cell)).length;
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
      missingOffsets.length * 100
    );
  }

  async function buildTableModel(root, index, sectionContext, options = {}) {
    const rect = root.getBoundingClientRect();
    const scanData = await collectTableScanData(root, options);
    const headerInfos = scanData.headerInfos;
    const headers = normalizeHeaders(buildHeadersFromHeaderInfos(headerInfos), headerInfos);
    const rows = buildBodyRowModels(scanData.rowGroups, headers, headerInfos);

    return {
      index,
      root,
      sourceTitle: sectionContext?.title || "",
      sourceWrapperTop: Number.isFinite(rect.top) ? Math.round(rect.top) : null,
      headers,
      headerInfos,
      rows,
      scanStats: scanData.stats
    };
  }

  async function collectTableScanData(root, options = {}) {
    const targetGroups = normalizeTargetTextGroups(options.targetGroups || options.targetTexts);
    const scrollState = createTableScrollState(root);
    const originalScrolls = snapshotScrollerPositions(scrollState.scrollers);
    const originalWindowScroll = {
      left: window.scrollX,
      top: window.scrollY
    };
    const accumulator = createTableScanAccumulator();
    const xPositions = getScrollPositions(scrollState.horizontalScroller, "x", TABLE_SCROLL_MAX_X_STEPS);
    const yPositions = getScrollPositions(scrollState.verticalScroller, "y", TABLE_SCROLL_MAX_Y_STEPS);
    const targetYPositions = [];

    try {
      root.scrollIntoView({
        block: "center",
        inline: "nearest"
      });
      await sleep(TABLE_SCROLL_RENDER_DELAY_MS);

      for (const x of xPositions) {
        throwIfStopped();
        await setTableScrollPosition(scrollState, x, getScrollerTop(scrollState.verticalScroller));
        collectVisibleTableSnapshot(root, scrollState, accumulator);
      }

      for (const y of yPositions) {
        throwIfStopped();
        await setTableScrollPosition(scrollState, 0, y);
        const snapshot = collectVisibleTableSnapshot(root, scrollState, accumulator);
        if (targetGroups.length && snapshot.rows.some((row) => row.text && targetGroups.some((group) => group.some((text) => row.text.includes(text))))) {
          targetYPositions.push(y);
        }
        if (targetGroups.length && hasFoundAllTargetGroups(accumulator, targetGroups)) {
          break;
        }
      }

      const rowsToExpand = targetYPositions.length ? targetYPositions : [getScrollerTop(scrollState.verticalScroller)];
      for (const y of uniqueNumbers(rowsToExpand)) {
        for (const x of xPositions) {
          throwIfStopped();
          await setTableScrollPosition(scrollState, x, y);
          collectVisibleTableSnapshot(root, scrollState, accumulator);
        }
      }
    } finally {
      restoreScrollerPositions(originalScrolls);
      window.scrollTo(originalWindowScroll.left, originalWindowScroll.top);
      await sleep(TABLE_SCROLL_RENDER_DELAY_MS);
    }

    return {
      headerInfos: Array.from(accumulator.headerMap.values()).sort(compareCellInfos),
      rowGroups: Array.from(accumulator.rowMap.values()),
      stats: {
        xPositions: xPositions.length,
        yPositions: yPositions.length,
        targetYPositions: targetYPositions.length,
        horizontalScrollable: isScrollableOnAxis(scrollState.horizontalScroller, "x"),
        verticalScrollable: isScrollableOnAxis(scrollState.verticalScroller, "y")
      }
    };
  }

  function createTableScrollState(root) {
    const scrollers = findTableScrollers(root);
    const horizontalScroller = chooseBestScroller(scrollers, "x") || root;
    const verticalScroller = chooseBestScroller(scrollers, "y") || horizontalScroller || root;

    return {
      root,
      scrollers,
      horizontalScroller,
      verticalScroller,
      snapshotId: 0
    };
  }

  function findTableScrollers(root) {
    const preferredSelectors = [
      ".vxe-table--body-wrapper",
      ".vxe-table--header-wrapper",
      ".vxe-table--footer-wrapper",
      ".vxe-table--scroll-x-wrapper",
      ".vxe-table--scroll-y-wrapper",
      ".body--wrapper",
      ".header--wrapper",
      ".el-table__body-wrapper",
      ".ant-table-body",
      ".arco-table-body",
      ".semi-table-body"
    ].join(",");

    const preferred = Array.from(root.querySelectorAll(preferredSelectors));
    const scrollable = Array.from(root.querySelectorAll("*")).filter(
      (node) => isScrollableOnAxis(node, "x") || isScrollableOnAxis(node, "y")
    );

    return uniqueNodes([root, ...preferred, ...scrollable]).filter((node) => node instanceof Element);
  }

  function chooseBestScroller(scrollers, axis) {
    const candidates = scrollers
      .map((node) => ({
        node,
        overflow: getScrollOverflow(node, axis),
        score: scoreScrollerCandidate(node, axis)
      }))
      .filter((item) => item.overflow > 1)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return b.overflow - a.overflow;
      });

    return candidates[0]?.node || null;
  }

  function scoreScrollerCandidate(node, axis) {
    const className = String(node.className || "");
    let score = 0;
    if (/vxe-table--body-wrapper|body--wrapper|ant-table-body|el-table__body-wrapper|arco-table-body|semi-table-body/.test(className)) {
      score += 80;
    }
    if (axis === "x" && /header-wrapper|scroll-x/.test(className)) {
      score += 20;
    }
    if (axis === "y" && /scroll-y/.test(className)) {
      score += 20;
    }
    if (node.querySelector?.("tbody tr,.vxe-table--body tr,[role='row']")) {
      score += 20;
    }
    return score;
  }

  function snapshotScrollerPositions(scrollers) {
    return uniqueNodes(scrollers).map((node) => ({
      node,
      left: node.scrollLeft,
      top: node.scrollTop
    }));
  }

  function restoreScrollerPositions(scrolls) {
    scrolls.forEach((item) => {
      item.node.scrollLeft = item.left;
      item.node.scrollTop = item.top;
    });
  }

  function getScrollPositions(scroller, axis, maxSteps) {
    if (!scroller) {
      return [0];
    }

    const axisMax = axis === "x"
      ? Math.max(0, scroller.scrollWidth - scroller.clientWidth)
      : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (axisMax <= 1) {
      return [0];
    }

    const viewport = axis === "x" ? scroller.clientWidth : scroller.clientHeight;
    const step = Math.max(80, Math.floor((viewport || axisMax) * TABLE_SCROLL_STEP_RATIO));
    const positions = [0];

    for (let value = step; value < axisMax && positions.length < maxSteps - 1; value += step) {
      positions.push(value);
    }
    positions.push(axisMax);

    return uniqueNumbers(positions.map((value) => Math.round(Math.max(0, Math.min(axisMax, value)))));
  }

  async function setTableScrollPosition(scrollState, left, top) {
    const targets = new Map();
    addScrollerTarget(targets, scrollState.horizontalScroller, left, null);
    addScrollerTarget(targets, scrollState.verticalScroller, null, top);

    scrollState.scrollers.forEach((scroller) => {
      if (isScrollableOnAxis(scroller, "x")) {
        addScrollerTarget(targets, scroller, left, null);
      }
      if (isScrollableOnAxis(scroller, "y")) {
        addScrollerTarget(targets, scroller, null, top);
      }
    });

    targets.forEach((target, scroller) => setScrollerPosition(scroller, target.left, target.top));
    await sleep(TABLE_SCROLL_RENDER_DELAY_MS);
  }

  function addScrollerTarget(targets, scroller, left, top) {
    if (!scroller) {
      return;
    }
    const target = targets.get(scroller) || {
      left: null,
      top: null
    };
    if (Number.isFinite(left)) {
      target.left = left;
    }
    if (Number.isFinite(top)) {
      target.top = top;
    }
    targets.set(scroller, target);
  }

  function setScrollerPosition(scroller, left, top) {
    if (!scroller) {
      return;
    }
    if (Number.isFinite(left) && isScrollableOnAxis(scroller, "x")) {
      scroller.scrollLeft = left;
    }
    if (Number.isFinite(top) && isScrollableOnAxis(scroller, "y")) {
      scroller.scrollTop = top;
    }
  }

  function getScrollerTop(scroller) {
    return Number.isFinite(scroller?.scrollTop) ? scroller.scrollTop : 0;
  }

  function isScrollableOnAxis(node, axis) {
    if (!node) {
      return false;
    }
    return getScrollOverflow(node, axis) > 1;
  }

  function getScrollOverflow(node, axis) {
    if (!node) {
      return 0;
    }
    return axis === "x"
      ? Math.max(0, node.scrollWidth - node.clientWidth)
      : Math.max(0, node.scrollHeight - node.clientHeight);
  }

  function createTableScanAccumulator() {
    return {
      headerMap: new Map(),
      rowMap: new Map()
    };
  }

  function collectVisibleTableSnapshot(root, scrollState, accumulator) {
    scrollState.snapshotId += 1;
    const headerRows = collectHeaderRows(root);
    const headerInfos = buildHeaderInfos(headerRows, scrollState);
    const bodyRows = collectBodyRows(root, headerRows);
    const rowGroups = collectBodyRowGroups(bodyRows, scrollState);

    headerInfos.forEach((cell) => mergeCellInfoMap(accumulator.headerMap, cell, headerInfoKey(cell)));
    rowGroups.forEach((group) => {
      const key = group.rowKey;
      let current = accumulator.rowMap.get(key);
      if (!current) {
        current = {
          ...group,
          parts: []
        };
        accumulator.rowMap.set(key, current);
      }
      current.parts.push(...group.parts);
      current.text = [current.text, group.text].filter(Boolean).join(" | ");
    });

    return {
      headers: headerInfos,
      rows: rowGroups.map((group) => ({
        ...group,
        text: group.parts.flatMap((part) => part.cells).map((cell) => cell.text).filter(Boolean).join(" | ")
      }))
    };
  }

  function collectBodyRowGroups(bodyRows, scrollState) {
    const rowGroups = [];

    bodyRows.forEach((rowNode) => {
      const cellInfos = collectCells(rowNode)
        .filter((cell) => !isHeaderCell(cell))
        .map((cell) => cellToInfo(cell, scrollState))
        .filter((cell) => cell.text);

      if (!cellInfos.length) {
        return;
      }

      const rect = rowNode.getBoundingClientRect();
      const top = getAbsoluteTop(rowNode, scrollState);
      const rowKey = getRowKey(rowNode, scrollState);
      let group = rowGroups.find((item) => item.rowKey === rowKey || Math.abs(item.top - top) <= TABLE_ROW_MERGE_TOLERANCE_PX);
      if (!group) {
        group = {
          rowKey,
          top,
          viewportTop: rect.top,
          snapshotId: scrollState?.snapshotId || 0,
          parts: [],
          text: ""
        };
        rowGroups.push(group);
      }
      group.parts.push({
        node: rowNode,
        cells: cellInfos
      });
      group.text = [group.text, ...cellInfos.map((cell) => cell.text)].filter(Boolean).join(" | ");
    });

    return rowGroups;
  }

  function normalizeTargetTextGroups(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    if (value.every((item) => typeof item === "string")) {
      return value.map((item) => [item].filter(Boolean));
    }

    return value
      .map((item) => (Array.isArray(item) ? item : [item]))
      .map((group) => group.map((text) => cleanText(text)).filter(Boolean))
      .filter((group) => group.length);
  }

  function hasFoundAllTargetGroups(accumulator, targetGroups) {
    if (!targetGroups.length) {
      return false;
    }

    const rowTexts = Array.from(accumulator.rowMap.values()).map((row) => row.text || "");
    return targetGroups.every((group) => rowTexts.some((rowText) => group.some((targetText) => rowText.includes(targetText))));
  }

  function mergeCellInfoMap(map, cell, key) {
    const existing = map.get(key);
    if (!existing) {
      map.set(key, cell);
      return;
    }

    if (cell.text.length > existing.text.length) {
      map.set(key, {
        ...existing,
        ...cell
      });
    }
  }

  function headerInfoKey(cell) {
    if (cell.columnKey) {
      return `col:${cell.columnKey}:${Math.round(cell.absoluteTop / TABLE_ROW_MERGE_TOLERANCE_PX)}:${cell.text}`;
    }
    return `${Math.round(cell.absoluteLeft / TABLE_COLUMN_MERGE_TOLERANCE_PX)}:${Math.round(cell.absoluteTop / TABLE_ROW_MERGE_TOLERANCE_PX)}:${cell.text}`;
  }

  function getRowKey(rowNode, scrollState) {
    const rowId = [
      rowNode.getAttribute("rowid"),
      rowNode.getAttribute("data-rowid"),
      rowNode.getAttribute("data-row-id"),
      rowNode.dataset?.rowid,
      rowNode.dataset?.rowId,
      rowNode.getAttribute("aria-rowindex")
    ]
      .map((value) => cleanText(value))
      .find(Boolean);

    if (rowId) {
      return `id:${rowId}`;
    }

    return `top:${Math.round(getAbsoluteTop(rowNode, scrollState) / TABLE_ROW_MERGE_TOLERANCE_PX)}`;
  }

  function getAbsoluteLeft(node, scrollState) {
    const rect = node.getBoundingClientRect();
    const scroller = scrollState?.horizontalScroller;
    const scrollerRect = scroller?.getBoundingClientRect?.();
    if (scroller && scrollerRect && Number.isFinite(scroller.scrollLeft)) {
      return rect.left - scrollerRect.left + scroller.scrollLeft;
    }
    return rect.left + window.scrollX;
  }

  function getAbsoluteTop(node, scrollState) {
    const rect = node.getBoundingClientRect();
    const scroller = scrollState?.verticalScroller;
    const scrollerRect = scroller?.getBoundingClientRect?.();
    if (scroller && scrollerRect && Number.isFinite(scroller.scrollTop)) {
      return rect.top - scrollerRect.top + scroller.scrollTop;
    }
    return rect.top + window.scrollY;
  }

  function buildBodyRowModels(rowGroups, headers, headerInfos) {
    const rows = [];
    const seen = new Set();
    const mergedRowGroups = mergeViewportSiblingRowGroups(rowGroups);

    mergedRowGroups
      .sort((a, b) => a.top - b.top)
      .forEach((group, rowIndex) => {
        const cellInfos = dedupeCellInfos(group.parts.flatMap((part) => part.cells)).sort(compareCellInfos);
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

  function mergeViewportSiblingRowGroups(rowGroups) {
    const groups = [];

    rowGroups
      .slice()
      .sort((a, b) => {
        const viewportDiff = (a.viewportTop ?? a.top ?? 0) - (b.viewportTop ?? b.top ?? 0);
        if (Math.abs(viewportDiff) > TABLE_ROW_VIEWPORT_MERGE_TOLERANCE_PX) {
          return viewportDiff;
        }
        return (a.top || 0) - (b.top || 0);
      })
      .forEach((rowGroup) => {
        const viewportTop = rowGroup.viewportTop ?? rowGroup.top;
        let target = groups.find(
          (group) =>
            group.snapshotId === rowGroup.snapshotId &&
            Math.abs((group.viewportTop ?? group.top ?? 0) - viewportTop) <= TABLE_ROW_VIEWPORT_MERGE_TOLERANCE_PX
        );

        if (!target) {
          target = {
            ...rowGroup,
            parts: [],
            text: ""
          };
          groups.push(target);
        }

        target.top = Math.min(target.top ?? rowGroup.top, rowGroup.top);
        target.viewportTop = Math.min(target.viewportTop ?? viewportTop, viewportTop);
        target.parts.push(...rowGroup.parts);
        target.text = [target.text, rowGroup.text].filter(Boolean).join(" | ");
      });

    return groups;
  }

  function buildHeadersFromHeaderInfos(headerInfos) {
    if (!Array.isArray(headerInfos) || !headerInfos.length) {
      return [];
    }

    const groups = groupHeaderInfosByRow(headerInfos);
    const grid = [];

    groups.forEach((cells, rowIndex) => {
      grid[rowIndex] ||= [];
      let columnIndex = 0;
      cells.forEach((cell) => {
        while (grid[rowIndex][columnIndex]) {
          columnIndex += 1;
        }

        const colSpan = Math.max(1, Number(cell.colSpan || 1));
        const rowSpan = Math.max(1, Number(cell.rowSpan || 1));
        for (let r = 0; r < rowSpan; r += 1) {
          for (let c = 0; c < colSpan; c += 1) {
            grid[rowIndex + r] ||= [];
            grid[rowIndex + r][columnIndex + c] = cell.text;
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

  function groupHeaderInfosByRow(headerInfos) {
    const groups = [];

    headerInfos
      .slice()
      .sort(compareCellInfos)
      .forEach((cell) => {
        let group = groups.find((item) => Math.abs(item.top - cell.absoluteTop) <= TABLE_ROW_MERGE_TOLERANCE_PX);
        if (!group) {
          group = {
            top: cell.absoluteTop,
            cells: []
          };
          groups.push(group);
        }
        group.cells.push(cell);
      });

    return groups
      .sort((a, b) => a.top - b.top)
      .map((group) => dedupeHeaderInfos(group.cells).sort(compareCellInfos));
  }

  function alignCellsToHeaders(cellInfos, headers, headerInfos) {
    const rawCells = cellInfos.map((cell) => cell.text);
    const headerColumns = getHeaderColumns(headers, headerInfos);
    if (!headerColumns.length || !rawCells.length) {
      return rawCells;
    }

    const usedIndexes = new Set();
    const aligned = headerColumns.map((header) => {
      if (header.columnKey) {
        const keyedMatch = cellInfos
          .map((cell, index) => ({
            cell,
            index
          }))
          .find((candidate) => !usedIndexes.has(candidate.index) && candidate.cell.columnKey === header.columnKey);
        if (keyedMatch) {
          usedIndexes.add(keyedMatch.index);
          return keyedMatch.cell.text;
        }
      }

      const candidates = cellInfos
        .map((cell, index) => ({
          cell,
          index,
          distance: Math.abs(cell.centerX - header.centerX)
        }))
        .filter((candidate) => !usedIndexes.has(candidate.index))
        .sort((a, b) => a.distance - b.distance);

      const tolerance = Math.max(40, header.width * 0.55);
      const nearCandidates = candidates.filter((candidate) => candidate.distance <= tolerance);
      const best = nearCandidates[0];

      if (!best) {
        return "";
      }

      usedIndexes.add(best.index);
      return best.cell.text;
    });

    const filledCount = aligned.filter(Boolean).length;
    return filledCount >= Math.min(headerColumns.length, rawCells.length) - 1 ? aligned : rawCells;
  }

  function getHeaderColumns(headers, headerInfos) {
    if (!Array.isArray(headers) || !headers.length || !Array.isArray(headerInfos) || !headerInfos.length) {
      return [];
    }

    const headerColumns = buildHeaderColumnInfos(headerInfos);
    if (headerColumns.length < headers.filter(Boolean).length) {
      return [];
    }

    return headers.map((header, index) => {
      const headerInfo = headerColumns[index];
      return {
        text: header || headerInfo?.text || "",
        columnKey: headerInfo?.columnKey || "",
        left: headerInfo?.absoluteLeft ?? headerInfo?.left ?? 0,
        width: headerInfo?.width || 80,
        centerX: headerInfo?.absoluteCenterX ?? headerInfo?.centerX ?? 0
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

  function buildHeaderInfos(headerRows, scrollState) {
    return dedupeCellInfos(
      headerRows
        .flatMap((row) => collectCells(row).map((cell) => headerCellToInfo(cell, scrollState)))
        .filter((cell) => cell.text || cell.width > 0)
    ).sort(compareCellInfos);
  }

  function buildHeaderColumnInfos(headerInfos) {
    const rows = groupHeaderInfosByRow(headerInfos);
    const grid = [];

    rows.forEach((cells, rowIndex) => {
      grid[rowIndex] ||= [];
      let columnIndex = 0;

      cells.forEach((cell) => {
        while (grid[rowIndex][columnIndex]) {
          columnIndex += 1;
        }

        const colSpan = Math.max(1, Number(cell.colSpan || 1));
        const rowSpan = Math.max(1, Number(cell.rowSpan || 1));
        for (let r = 0; r < rowSpan; r += 1) {
          for (let c = 0; c < colSpan; c += 1) {
            grid[rowIndex + r] ||= [];
            grid[rowIndex + r][columnIndex + c] = getSpannedHeaderInfo(cell, c, colSpan);
          }
        }
        columnIndex += colSpan;
      });
    });

    const maxColumns = grid.reduce((max, row) => Math.max(max, row.length), 0);
    const columns = [];

    for (let columnIndex = 0; columnIndex < maxColumns; columnIndex += 1) {
      for (let rowIndex = grid.length - 1; rowIndex >= 0; rowIndex -= 1) {
        const cell = grid[rowIndex]?.[columnIndex];
        if (cell) {
          columns[columnIndex] = cell;
          break;
        }
      }
    }

    return columns.filter(Boolean);
  }

  function getSpannedHeaderInfo(cell, spanIndex, colSpan) {
    if (colSpan <= 1) {
      return cell;
    }

    const width = (cell.width || 80) / colSpan;
    const left = (cell.left || 0) + width * spanIndex;
    const absoluteLeft = (cell.absoluteLeft || cell.left || 0) + width * spanIndex;

    return {
      ...cell,
      columnKey: cell.columnKey ? `${cell.columnKey}:${spanIndex}` : "",
      left,
      absoluteLeft,
      width,
      centerX: absoluteLeft + width / 2,
      absoluteCenterX: absoluteLeft + width / 2
    };
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
    const candidates = uniqueNodes([
      ...document.querySelectorAll("h3"),
      ...document.querySelectorAll(
        "h1,h2,h4,h5,h6,header,section,article,div,span,p,.ant-card-head-title,.el-card__header"
      )
    ]).filter((node) => {
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

  function findTargetRow(model, target) {
    const candidates = normalizeTargetTextGroups([target?.candidates || [target?.label, target?.dateText]])[0] || [];
    const targetDateText = cleanText(target?.dateText);

    return (
      model.rows.find((row) => {
        const firstDate = extractDateText(row.cells?.[0]);
        return firstDate && firstDate === targetDateText;
      }) ||
      model.rows.find((row) => candidates.some((candidate) => row.text.includes(candidate))) ||
      null
    );
  }

  function extractDateText(value) {
    const match = /(\d{4}-\d{2}-\d{2})/.exec(cleanText(value));
    return match?.[1] || "";
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

  function cellToInfo(cell, scrollState) {
    const rect = cell.getBoundingClientRect();
    const absoluteLeft = getAbsoluteLeft(cell, scrollState);
    const absoluteTop = getAbsoluteTop(cell, scrollState);
    return {
      text: cleanText(getVisibleText(cell)),
      columnKey: getCellColumnKey(cell),
      left: absoluteLeft,
      top: absoluteTop,
      viewportLeft: rect.left,
      viewportTop: rect.top,
      absoluteLeft,
      absoluteTop,
      width: rect.width,
      centerX: absoluteLeft + rect.width / 2,
      absoluteCenterX: absoluteLeft + rect.width / 2
    };
  }

  function headerCellToInfo(cell, scrollState) {
    return {
      ...cellToInfo(cell, scrollState),
      colSpan: Number(cell.getAttribute("colspan") || cell.colSpan || 1),
      rowSpan: Number(cell.getAttribute("rowspan") || cell.rowSpan || 1)
    };
  }

  function getCellColumnKey(cell) {
    const direct = [
      cell.getAttribute("colid"),
      cell.getAttribute("data-colid"),
      cell.getAttribute("data-column-id"),
      cell.getAttribute("data-col-id"),
      cell.getAttribute("aria-colindex"),
      cell.dataset?.colid,
      cell.dataset?.columnId,
      cell.dataset?.colId
    ]
      .map((value) => cleanText(value))
      .find(Boolean);

    if (direct) {
      return direct;
    }

    const classes = String(cell.className || "").split(/\s+/).filter(Boolean);
    const colClass = classes.find((name) => /^col_[A-Za-z0-9_$-]+$/.test(name));
    if (colClass) {
      return colClass;
    }

    return "";
  }

  function compareCellInfos(a, b) {
    if (Math.abs((a.top || 0) - (b.top || 0)) > TABLE_ROW_MERGE_TOLERANCE_PX) {
      return (a.top || 0) - (b.top || 0);
    }
    return (a.left || 0) - (b.left || 0);
  }

  function dedupeCellInfos(cells) {
    const seen = new Set();
    return cells.filter((cell) => {
      const key = cell.columnKey
        ? `col:${cell.columnKey}:${Math.round(cell.top / TABLE_ROW_MERGE_TOLERANCE_PX)}:${cell.text}`
        : `${Math.round(cell.left / TABLE_COLUMN_MERGE_TOLERANCE_PX)}:${Math.round(cell.top / TABLE_ROW_MERGE_TOLERANCE_PX)}:${cell.text}`;
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
      const key = cell.columnKey
        ? `col:${cell.columnKey}:${Math.round(cell.top / TABLE_ROW_MERGE_TOLERANCE_PX)}:${cell.text}`
        : `${Math.round(cell.left / TABLE_COLUMN_MERGE_TOLERANCE_PX)}:${Math.round(cell.top / TABLE_ROW_MERGE_TOLERANCE_PX)}:${cell.text}`;
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

  function uniqueNumbers(values) {
    return Array.from(new Set(values.filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
  }

  function uniqueNumbersInOrder(values) {
    const seen = new Set();
    const result = [];
    values
      .filter((value) => Number.isFinite(value))
      .forEach((value) => {
        const normalized = Math.round(value);
        if (seen.has(normalized)) {
          return;
        }
        seen.add(normalized);
        result.push(normalized);
      });
    return result;
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

  function formatRowOffsets(offsets) {
    return offsets.map(formatRowOffset).join("、");
  }

  function formatRowOffset(offset) {
    return Number(offset) === 0 ? "r" : `r${offset}`;
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
