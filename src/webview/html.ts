export function getSuperpowersPanelHtmlContent(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Superpowers Explorer</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
      margin-bottom: 16px;
    }
    .tab {
      padding: 8px 16px;
      cursor: pointer;
      font-size: 13px;
      color: var(--vscode-tab-inactiveForeground);
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    .tab:hover {
      color: var(--vscode-tab-activeForeground);
    }
    .tab.active {
      color: var(--vscode-tab-activeForeground);
      border-bottom-color: var(--vscode-tab-activeBorder);
    }
    .tab .count {
      font-weight: normal;
      margin-left: 4px;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .data-table th {
      text-align: left;
      padding: 8px 12px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .data-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground);
    }
    .data-table tr:hover td {
      background: var(--vscode-list-hoverBackground);
    }
    .data-table .name {
      cursor: pointer;
    }
    .data-table .name:hover {
      color: var(--vscode-textLink-foreground);
    }
    .data-table .date {
      color: var(--vscode-descriptionForeground);
    }
    .data-table .progress {
      color: var(--vscode-descriptionForeground);
    }
    .data-table .progress.complete {
      color: #4ec9b0;
    }
    .data-table .action {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }
    .data-table .action:hover {
      text-decoration: underline;
    }
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .status-badge:hover {
      opacity: 0.9;
    }
    .status-badge.completed {
      background: #1a5f1a;
      color: #4ec9b0;
      border-color: #4ec9b0;
    }
    .status-badge.needsTesting {
      background: #5f3d00;
      color: #ce9178;
      border-color: #ce9178;
    }
    .status-badge.default {
      background: #3d3d3d;
      color: #cccccc;
      border-color: #888888;
    }
    .status-dropdown {
      position: absolute;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      z-index: 1000;
      min-width: 120px;
      display: none;
    }
    .status-dropdown.show {
      display: block;
    }
    .status-dropdown-item {
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
    }
    .status-dropdown-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      padding: 16px;
      text-align: center;
    }
    .toolbar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 12px;
    }
    .refresh-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .refresh-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="refresh-btn" onclick="refresh()">刷新</button>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="specs" onclick="switchTab('specs')">
      Specs<span class="count" id="specs-count">(0)</span>
    </div>
    <div class="tab" data-tab="plans" onclick="switchTab('plans')">
      Plans<span class="count" id="plans-count">(0)</span>
    </div>
  </div>

  <div class="tab-content active" id="specs-tab">
    <table class="data-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>日期</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="specs-body"></tbody>
    </table>
  </div>

  <div class="tab-content" id="plans-tab">
    <table class="data-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>日期</th>
          <th>进度</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="plans-body"></tbody>
    </table>
  </div>

  <div class="status-dropdown" id="status-dropdown">
    <div class="status-dropdown-item" data-status="completed" onclick="selectStatus('completed')">已完成</div>
    <div class="status-dropdown-item" data-status="needsTesting" onclick="selectStatus('needsTesting')">需要测试</div>
    <div class="status-dropdown-item" data-status="default" onclick="selectStatus('default')">进行中</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const statusDropdown = document.getElementById('status-dropdown');
    let currentPlanPath = null;
    let currentStatus = null;

    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('[data-tab="' + tabName + '"]').classList.add('active');
      document.getElementById(tabName + '-tab').classList.add('active');
    }

    function openFile(path) {
      vscode.postMessage({ command: 'openFile', path });
    }

    function refresh() {
      vscode.postMessage({ command: 'refresh' });
    }

    function showStatusDropdown(event, path, status) {
      event.stopPropagation();
      currentPlanPath = path;
      currentStatus = status;
      
      // 隐藏当前状态的选项
      document.querySelectorAll('.status-dropdown-item').forEach(item => {
        item.style.display = item.dataset.status === status ? 'none' : 'block';
      });
      
      statusDropdown.style.left = event.clientX + 'px';
      statusDropdown.style.top = (event.clientY + 20) + 'px';
      statusDropdown.classList.add('show');
    }

    function hideStatusDropdown() {
      statusDropdown.classList.remove('show');
      currentPlanPath = null;
      currentStatus = null;
    }

    function selectStatus(status) {
      if (currentPlanPath && status !== currentStatus) {
        vscode.postMessage({ command: 'setPlanStatus', path: currentPlanPath, status });
      }
      hideStatusDropdown();
    }

    document.addEventListener('click', hideStatusDropdown);

    function getStatusText(status) {
      switch (status) {
        case 'completed': return '已完成';
        case 'needsTesting': return '需要测试';
        default: return '进行中';
      }
    }

    function renderSpecs(specs) {
      const tbody = document.getElementById('specs-body');
      document.getElementById('specs-count').textContent = '(' + specs.length + ')';

      if (specs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无 Specs</td></tr>';
        return;
      }

      let html = '';
      specs.forEach(spec => {
        html += '<tr>';
        html += '<td class="name" onclick="openFile(\\'' + spec.path + '\\')">' + spec.title + '</td>';
        html += '<td class="date">' + spec.date + '</td>';
        html += '<td class="action" onclick="openFile(\\'' + spec.path + '\\')">打开</td>';
        html += '</tr>';
      });
      tbody.innerHTML = html;
    }

    function renderPlans(plans) {
      const tbody = document.getElementById('plans-body');
      document.getElementById('plans-count').textContent = '(' + plans.length + ')';

      if (plans.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无 Plans</td></tr>';
        return;
      }

      let html = '';
      plans.forEach(plan => {
        const progressText = plan.progress.completed + '/' + plan.progress.total;
        const progressClass = plan.status === 'completed' ? 'complete' : '';
        const statusClass = plan.status || 'default';
        const statusText = getStatusText(plan.status);

        html += '<tr>';
        html += '<td class="name" onclick="openFile(\\'' + plan.path + '\\')">' + plan.title + '</td>';
        html += '<td class="date">' + plan.date + '</td>';
        html += '<td class="progress ' + progressClass + '">' + progressText + '</td>';
        html += '<td><span class="status-badge ' + statusClass + '" onclick="showStatusDropdown(event, \\'' + plan.path + '\\', \\'' + statusClass + '\\')">' + statusText + ' ▾</span></td>';
        html += '<td class="action" onclick="openFile(\\'' + plan.path + '\\')">打开</td>';
        html += '</tr>';
      });
      tbody.innerHTML = html;
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'updateData') {
        renderSpecs(message.data.specs);
        renderPlans(message.data.plans);
      }
    });
  </script>
</body>
</html>`
}
