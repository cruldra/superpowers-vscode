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
    .data-table .action.delete {
      color: #f48771;
    }
    .data-table .action.delete:hover {
      color: #ff6b6b;
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
    .sortable {
      cursor: pointer;
      user-select: none;
    }
    .sortable:hover {
      color: var(--vscode-textLink-foreground);
    }
    .sortable .sort-icon {
      margin-left: 4px;
      opacity: 0.5;
    }
    .sortable.asc .sort-icon::after {
      content: '▲';
    }
    .sortable.desc .sort-icon::after {
      content: '▼';
    }
    .sortable.none .sort-icon::after {
      content: '▾';
      opacity: 0.3;
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
          <th class="sortable" onclick="sortSpecs('date')">日期<span class="sort-icon"></span></th>
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
          <th class="sortable" onclick="sortPlans('date')">日期<span class="sort-icon"></span></th>
          <th class="sortable" onclick="sortPlans('progress')">进度<span class="sort-icon"></span></th>
          <th class="sortable" onclick="sortPlans('status')">状态<span class="sort-icon"></span></th>
          <th>任务状态</th>
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
    
    // 排序状态
    let specsSortField = 'date';
    let specsSortOrder = 'desc';
    let plansSortField = 'date';
    let plansSortOrder = 'desc';
    
    // 原始数据
    let specsData = [];
    let plansData = [];

    function switchTab(tabName) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.querySelector('[data-tab="' + tabName + '"]').classList.add('active');
      document.getElementById(tabName + '-tab').classList.add('active');
    }

    function openFile(path) {
      vscode.postMessage({ command: 'openFile', path, preview: true });
    }

    function deleteFile(path, type) {
      vscode.postMessage({ command: 'deleteFile', path, type });
    }

    function runPlan(path) {
      vscode.postMessage({ command: 'runPlan', path });
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

    function getTaskStatusText(taskStatus) {
      switch (taskStatus) {
        case 'running': return '运行中';
        case 'completed': return '已完成';
        case 'failed': return '失败';
        default: return '';
      }
    }
    
    // 状态排序权重：进行中(0) > 需要测试(1) > 已完成(2)
    function getStatusWeight(status) {
      switch (status) {
        case 'default': return 0;
        case 'needsTesting': return 1;
        case 'completed': return 2;
        default: return 3;
      }
    }
    
    function sortSpecs(field) {
      if (specsSortField === field) {
        specsSortOrder = specsSortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        specsSortField = field;
        specsSortOrder = 'desc';
      }
      
      const sorted = [...specsData].sort((a, b) => {
        let cmp = 0;
        if (field === 'date') {
          cmp = a.date.localeCompare(b.date);
        }
        return specsSortOrder === 'asc' ? cmp : -cmp;
      });
      
      renderSpecsTable(sorted);
    }
    
    function sortPlans(field) {
      if (plansSortField === field) {
        plansSortOrder = plansSortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        plansSortField = field;
        plansSortOrder = 'desc';
      }
      
      const sorted = [...plansData].sort((a, b) => {
        let cmp = 0;
        if (field === 'date') {
          cmp = a.date.localeCompare(b.date);
        } else if (field === 'progress') {
          const aRatio = a.progress.total > 0 ? a.progress.completed / a.progress.total : 0;
          const bRatio = b.progress.total > 0 ? b.progress.completed / b.progress.total : 0;
          cmp = aRatio - bRatio;
        } else if (field === 'status') {
          cmp = getStatusWeight(a.status) - getStatusWeight(b.status);
        }
        return plansSortOrder === 'asc' ? cmp : -cmp;
      });
      
      renderPlansTable(sorted);
    }

    function renderSpecs(specs) {
      specsData = specs;
      
      // 应用当前排序
      const sorted = [...specsData].sort((a, b) => {
        let cmp = 0;
        if (specsSortField === 'date') {
          cmp = a.date.localeCompare(b.date);
        }
        return specsSortOrder === 'asc' ? cmp : -cmp;
      });
      
      renderSpecsTable(sorted);
    }
    
    function renderSpecsTable(specs) {
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
        html += '<td class="action delete" onclick="deleteFile(\\'' + spec.path + '\\', \\'spec\\')">删除</td>';
        html += '</tr>';
      });
      tbody.innerHTML = html;
    }

    function renderPlans(plans) {
      plansData = plans;
      
      // 应用当前排序
      const sorted = [...plansData].sort((a, b) => {
        let cmp = 0;
        if (plansSortField === 'date') {
          cmp = a.date.localeCompare(b.date);
        } else if (plansSortField === 'progress') {
          const aRatio = a.progress.total > 0 ? a.progress.completed / a.progress.total : 0;
          const bRatio = b.progress.total > 0 ? b.progress.completed / b.progress.total : 0;
          cmp = aRatio - bRatio;
        } else if (plansSortField === 'status') {
          cmp = getStatusWeight(a.status) - getStatusWeight(b.status);
        }
        return plansSortOrder === 'asc' ? cmp : -cmp;
      });
      
      renderPlansTable(sorted);
    }
    
    function renderPlansTable(plans) {
      const tbody = document.getElementById('plans-body');
      document.getElementById('plans-count').textContent = '(' + plans.length + ')';

      if (plans.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无 Plans</td></tr>';
        return;
      }

      let html = '';
      plans.forEach(plan => {
        const progressText = plan.progress.completed + '/' + plan.progress.total;
        const progressClass = plan.status === 'completed' ? 'complete' : '';
        const statusClass = plan.status || 'default';
        const statusText = getStatusText(plan.status);
        const taskStatusText = getTaskStatusText(plan.taskStatus);
        const runActionHtml = plan.taskStatus === 'running'
          ? ''
          : '<span class="action" onclick="runPlan(\\'' + plan.path + '\\')">运行</span> ';

        html += '<tr>';
        html += '<td class="name" onclick="openFile(\\'' + plan.path + '\\')">' + plan.title + '</td>';
        html += '<td class="date">' + plan.date + '</td>';
        html += '<td class="progress ' + progressClass + '">' + progressText + '</td>';
        html += '<td><span class="status-badge ' + statusClass + '" onclick="showStatusDropdown(event, \\'' + plan.path + '\\', \\'' + statusClass + '\\')">' + statusText + ' ▾</span></td>';
        html += '<td>' + taskStatusText + '</td>';
        html += '<td>' + runActionHtml + '<span class="action delete" onclick="deleteFile(\\'' + plan.path + '\\', \\'plan\\')">删除</span></td>';
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
