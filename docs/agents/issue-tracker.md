# GitHub 工单跟踪

在 `MengKaiTao88/remoteai` 的 GitHub Issues 中维护需求规格和工单。执行 `gh issue` 和 `gh pr` 命令时传入 `--repo MengKaiTao88/remoteai`，调用 `gh api` 时使用 `repos/MengKaiTao88/remoteai/` 路径。

## 工单操作

- 用 `gh issue create --repo MengKaiTao88/remoteai --title "..." --body-file <file>` 发布需求规格或工单。
- 用 `gh issue view <number> --repo MengKaiTao88/remoteai --json number,title,body,state,labels,comments` 读取工单。
- 用 `gh issue list --repo MengKaiTao88/remoteai --state open --json number,title,body,labels,comments` 列出待处理工单。按任务需要设置筛选条件和结果数量上限。
- 按 [分流标签](triage-labels.md) 的约定设置标签。使用 `gh issue edit <number> --repo MengKaiTao88/remoteai --add-label <label>` 添加，使用 `--remove-label <label>` 移除。
- 用 `gh issue comment <number> --repo MengKaiTao88/remoteai --body-file <file>` 补充信息。处理完毕后先发布说明，再运行 `gh issue close <number> --repo MengKaiTao88/remoteai` 关闭工单。

## 子工单与依赖

- 创建子工单时用 `--parent <parent>` 关联父工单，也可用 `gh issue edit <parent> --repo MengKaiTao88/remoteai --add-sub-issue <child>` 补建关联。功能不可用时，在子工单正文中加入 `Part of #<parent>`。
- 创建工单时用 `--blocked-by <blocker>` 标记阻塞依赖，也可用 `gh issue edit <child> --repo MengKaiTao88/remoteai --add-blocked-by <blocker>` 补建依赖。功能不可用时，在工单正文中加入 `Blocked by: #<blocker>`。
- 用 `gh api repos/MengKaiTao88/remoteai/issues/<number> --jq .issue_dependencies_summary.blocked_by` 检查未解决的依赖。依赖写在正文中时，逐项检查所引用工单的状态。所有阻塞工单关闭后，该工单才可继续处理。

## 外部拉取请求分流

**外部拉取请求参与分流（`PRs as a request surface`）为 `no`。**

设为 `yes` 时，使用工单的标签和状态体系分流外部拉取请求。在上方指定的仓库使用 `gh pr view`、`gh pr diff`、`gh pr comment`、`gh pr edit` 和 `gh pr close`。

## 工单路线图

- 将路线图建为带 `wayfinder:map` 标签的工单。子工单使用对应的 `wayfinder:<type>` 标签，可选类型为 `research`、`prototype`、`grilling` 或 `task`。按路线图需要创建标签。
- 用 `gh api --paginate repos/MengKaiTao88/remoteai/issues/<map>/sub_issues` 列出子工单。子工单功能不可用时，在路线图正文中维护任务列表，并在各子工单正文中链接路线图。
- 按路线图顺序，选择第一个尚未关闭、没有未解决阻塞项且无人负责的子工单。用 `gh issue edit <number> --repo MengKaiTao88/remoteai --add-assignee @me` 认领。
- 解决工单时，先发布处理结果，再关闭工单，并在路线图中记录决策及工单链接。
