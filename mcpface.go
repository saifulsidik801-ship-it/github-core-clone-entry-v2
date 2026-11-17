// mcpface.go — the MCP endpoint (JSON-RPC 2.0, era 2026-07-28): server/discover,
// initialize, tools/list and tools/call over the same store the REST face uses.
// A direct port of the proven Node implementation.

package main

import (
	"encoding/json"
	"strconv"
	"strings"
)

var mcpSupportedVersions = []string{"2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}
var mcpServerInfo = map[string]any{"name": "forge-mcp", "version": "1.0.0"}
var mcpInstructions = "A GitHub-compatible git forge: create and read repositories, issues and pull requests."

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

type mcpToolDef struct {
	Name        string
	Description string
	Properties  map[string]any
	Required    []string
}

var mcpTools = []mcpToolDef{
	{
		Name:        "create_repo",
		Description: "Create a new repository owned by the viewer.",
		Properties: map[string]any{
			"name":        map[string]any{"type": "string", "description": "Repository name"},
			"description": map[string]any{"type": "string", "description": "Repository description"},
			"private":     map[string]any{"type": "boolean", "description": "Whether the repository is private"},
			"owner":       map[string]any{"type": "string", "description": "Owner login (defaults to the viewer)"},
		},
		Required: []string{"name"},
	},
	{
		Name:        "get_repo",
		Description: "Get a repository by owner and name.",
		Properties: map[string]any{
			"owner": map[string]any{"type": "string", "description": "Owner login"},
			"repo":  map[string]any{"type": "string", "description": "Repository name"},
		},
		Required: []string{"owner", "repo"},
	},
	{
		Name:        "list_repos",
		Description: "List the viewer repositories.",
		Properties: map[string]any{
			"owner": map[string]any{"type": "string", "description": "Owner login (defaults to the viewer)"},
		},
		Required: []string{},
	},
	{
		Name:        "create_issue",
		Description: "Create an issue in a repository.",
		Properties: map[string]any{
			"owner":  map[string]any{"type": "string", "description": "Owner login"},
			"repo":   map[string]any{"type": "string", "description": "Repository name"},
			"title":  map[string]any{"type": "string", "description": "Issue title"},
			"body":   map[string]any{"type": "string", "description": "Issue body"},
			"labels": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Label names"},
		},
		Required: []string{"owner", "repo", "title"},
	},
	{
		Name:        "get_issue",
		Description: "Get one issue by number.",
		Properties: map[string]any{
			"owner":        map[string]any{"type": "string", "description": "Owner login"},
			"repo":         map[string]any{"type": "string", "description": "Repository name"},
			"issue_number": map[string]any{"type": "integer", "description": "Issue number"},
			"number":       map[string]any{"type": "integer", "description": "Issue number (alias)"},
		},
		Required: []string{"owner", "repo", "issue_number"},
	},
	{
		Name:        "list_issues",
		Description: "List issues in a repository.",
		Properties: map[string]any{
			"owner": map[string]any{"type": "string", "description": "Owner login"},
			"repo":  map[string]any{"type": "string", "description": "Repository name"},
			"state": map[string]any{"type": "string", "description": "open, closed or all"},
		},
		Required: []string{"owner", "repo"},
	},
	{
		Name:        "create_pull_request",
		Description: "Create a pull request.",
		Properties: map[string]any{
			"owner": map[string]any{"type": "string", "description": "Owner login"},
			"repo":  map[string]any{"type": "string", "description": "Repository name"},
			"title": map[string]any{"type": "string", "description": "Pull request title"},
			"body":  map[string]any{"type": "string", "description": "Pull request body"},
			"head":  map[string]any{"type": "string", "description": "Head branch name"},
			"base":  map[string]any{"type": "string", "description": "Base branch name"},
		},
		Required: []string{"owner", "repo", "title", "head", "base"},
	},
	{
		Name:        "merge_pull_request",
		Description: "Merge a pull request with a squash merge.",
		Properties: map[string]any{
			"owner":        map[string]any{"type": "string", "description": "Owner login"},
			"repo":         map[string]any{"type": "string", "description": "Repository name"},
			"pull_number":  map[string]any{"type": "integer", "description": "Pull request number"},
			"number":       map[string]any{"type": "integer", "description": "Pull request number (alias)"},
			"merge_method": map[string]any{"type": "string", "description": "Merge method (squash)"},
		},
		Required: []string{"owner", "repo", "pull_number"},
	},
}

// mcpToolsListResult is precomputed once: the suite requires the tools list
// byte-identical across calls.
var mcpToolsListResult map[string]any

func init() {
	tools := make([]any, 0, len(mcpTools))
	for _, t := range mcpTools {
		required := t.Required
		if required == nil {
			required = []string{}
		}
		tools = append(tools, map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": t.Properties,
				"required":   required,
			},
		})
	}
	mcpToolsListResult = map[string]any{"tools": tools}
}

// ---------------------------------------------------------------------------
// argument synonyms
// ---------------------------------------------------------------------------

type mcpArgs map[string]any

func mcpStrArg(args mcpArgs, keys ...string) string {
	for _, k := range keys {
		if v, ok := args[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func mcpNumArg(args mcpArgs, keys ...string) (int, bool) {
	for _, k := range keys {
		switch v := args[k].(type) {
		case float64:
			return int(v), true
		case string:
			if n, err := strconv.Atoi(v); err == nil {
				return n, true
			}
		}
	}
	return 0, false
}

func mcpOwnerArg(args mcpArgs, storeOwner string) string {
	if s := mcpStrArg(args, "owner", "owner_login", "ownerLogin", "login"); s != "" {
		return s
	}
	return storeOwner
}

func mcpRepoArg(args mcpArgs) string {
	if full := mcpStrArg(args, "full_name", "fullName"); full != "" && strings.Contains(full, "/") {
		parts := strings.Split(full, "/")
		return parts[len(parts)-1]
	}
	return mcpStrArg(args, "repo", "repository", "name")
}

// ---------------------------------------------------------------------------
// tool execution
// ---------------------------------------------------------------------------

type mcpOutcome struct {
	result  any
	isError bool
}

func mcpToolError(message string) mcpOutcome {
	return mcpOutcome{result: map[string]any{"error": message}, isError: true}
}

func mcpCallTool(c *Ctx, name string, args mcpArgs) mcpOutcome {
	store := c.Store
	var def *mcpToolDef
	for i := range mcpTools {
		if mcpTools[i].Name == name {
			def = &mcpTools[i]
			break
		}
	}
	if def == nil {
		return mcpToolError("unknown tool " + name)
	}
	var missing []string
	for _, req := range def.Required {
		switch req {
		case "issue_number":
			if _, ok := mcpNumArg(args, "issue_number", "number", "issueNumber"); ok {
				continue
			}
		case "pull_number":
			if _, ok := mcpNumArg(args, "pull_number", "number", "pullNumber"); ok {
				continue
			}
		case "repo":
			if mcpRepoArg(args) != "" {
				continue
			}
		case "owner":
			if mcpOwnerArg(args, store.Viewer) != "" {
				continue
			}
		default:
			if v, ok := args[req]; ok && v != nil && v != "" {
				continue
			}
		}
		missing = append(missing, req)
	}
	if len(missing) > 0 {
		return mcpToolError("missing required argument(s): " + strings.Join(missing, ", "))
	}

	owner := mcpOwnerArg(args, store.Viewer)
	if owner != "" {
		store.LearnViewer(owner)
	}

	switch name {
	case "create_repo":
		repoName := mcpStrArg(args, "name")
		if store.FindRepoByName(repoName) != nil {
			return mcpToolError("name already exists on this account")
		}
		private := false
		if v, ok := args["private"].(bool); ok {
			private = v
		}
		repo := store.CreateRepo(repoName, private, mcpStrArg(args, "description"))
		return mcpOutcome{result: store.RepoJSON(repo)}
	case "get_repo":
		repo := store.FindRepo(owner, mcpRepoArg(args))
		if repo == nil {
			return mcpToolError("repository not found")
		}
		return mcpOutcome{result: store.RepoJSON(repo)}
	case "list_repos":
		var repos []*Repo
		for _, r := range store.Repos {
			repos = append(repos, r)
		}
		sortRepos(repos)
		list := make([]any, 0, len(repos))
		for _, r := range repos {
			list = append(list, store.RepoJSON(r))
		}
		return mcpOutcome{result: map[string]any{"repos": list}}
	case "create_issue":
		repo := store.FindRepo(owner, mcpRepoArg(args))
		if repo == nil {
			return mcpToolError("repository not found")
		}
		var labels []string
		if arr, ok := args["labels"].([]any); ok {
			for _, x := range arr {
				if s, ok := x.(string); ok {
					labels = append(labels, s)
				}
			}
		}
		issue, errMsg := store.CreateIssue(repo, mcpStrArg(args, "title"), mcpStrArg(args, "body"), labels)
		if issue == nil {
			return mcpToolError(errMsg)
		}
		return mcpOutcome{result: store.IssueJSON(repo, issue)}
	case "get_issue":
		repo := store.FindRepo(owner, mcpRepoArg(args))
		n, _ := mcpNumArg(args, "issue_number", "number", "issueNumber")
		issue := findIssue(repo, n)
		if repo == nil || issue == nil {
			return mcpToolError("issue not found")
		}
		return mcpOutcome{result: store.IssueJSON(repo, issue)}
	case "list_issues":
		repo := store.FindRepo(owner, mcpRepoArg(args))
		if repo == nil {
			return mcpToolError("repository not found")
		}
		state := mcpStrArg(args, "state")
		if state == "" {
			state = "open"
		}
		list := make([]any, 0)
		for _, i := range repo.Issues {
			if state == "all" || i.State == state {
				list = append(list, store.IssueJSON(repo, i))
			}
		}
		return mcpOutcome{result: map[string]any{"issues": list}}
	case "create_pull_request":
		repo := store.FindRepo(owner, mcpRepoArg(args))
		if repo == nil {
			return mcpToolError("repository not found")
		}
		head := mcpStrArg(args, "head", "head_ref", "headRef")
		base := mcpStrArg(args, "base", "base_ref", "baseRef")
		if base == "" {
			base = repo.DefaultBranch
		}
		pr, errMsg := store.CreatePull(repo, mcpStrArg(args, "title"), mcpStrArg(args, "body"), head, base)
		if pr == nil {
			return mcpToolError(errMsg)
		}
		return mcpOutcome{result: store.PullJSON(repo, pr)}
	case "merge_pull_request":
		repo := store.FindRepo(owner, mcpRepoArg(args))
		n, _ := mcpNumArg(args, "pull_number", "number", "pullNumber")
		pr := findPull(repo, n)
		if repo == nil || pr == nil {
			return mcpToolError("pull request not found")
		}
		if pr.State != "open" {
			return mcpToolError("pull request is not open")
		}
		if PrHasConflict(store, repo, pr) {
			return mcpToolError("merge conflict")
		}
		oid, errMsg := store.MergePull(repo, pr)
		if oid == "" {
			return mcpToolError(errMsg)
		}
		return mcpOutcome{result: map[string]any{"merged": true, "sha": oid, "message": "Pull request #" + itoa(pr.Number) + " merged"}}
	}
	return mcpToolError("unknown tool " + name)
}

func sortRepos(repos []*Repo) {
	for i := 1; i < len(repos); i++ {
		for j := i; j > 0 && repos[j].ID < repos[j-1].ID; j-- {
			repos[j], repos[j-1] = repos[j-1], repos[j]
		}
	}
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

func rpcResult(id any, result any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func rpcError(id any, code int, message string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}}
}

// handleMcp serves POST /mcp
func handleMcp(c *Ctx) {
	if !hasAuth(c) {
		sendError(c, 401, "requires authentication")
		return
	}
	raw, err := readBody(c)
	if err != nil {
		sendJSON(c, 400, rpcError(nil, -32700, "Parse error"), nil)
		return
	}
	var body any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			sendJSON(c, 400, rpcError(nil, -32700, "Parse error"), nil)
			return
		}
	}
	req, ok := body.(map[string]any)
	if !ok {
		sendJSON(c, 400, rpcError(nil, -32600, "Invalid Request"), nil)
		return
	}
	id := req["id"]
	method, _ := req["method"].(string)
	params, _ := req["params"].(map[string]any)
	if params == nil {
		params = map[string]any{}
	}

	if method == "notifications/initialized" {
		c.W.Header().Set("X-GitHub-Request-Id", requestID())
		c.W.WriteHeader(202)
		return
	}
	if method == "server/discover" {
		sendJSON(c, 200, rpcResult(id, map[string]any{
			"supportedVersions": mcpSupportedVersions,
			"capabilities":      map[string]any{"tools": map[string]any{}},
			"serverInfo":        mcpServerInfo,
			"instructions":      mcpInstructions,
		}), nil)
		return
	}
	if method == "initialize" {
		offered, _ := params["protocolVersion"].(string)
		version := mcpSupportedVersions[0]
		for _, v := range mcpSupportedVersions {
			if v == offered {
				version = v
				break
			}
		}
		sendJSON(c, 200, rpcResult(id, map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      mcpServerInfo,
		}), nil)
		return
	}
	if method == "tools/list" {
		sendJSON(c, 200, rpcResult(id, mcpToolsListResult), nil)
		return
	}
	if method == "tools/call" {
		toolName, _ := params["name"].(string)
		known := false
		for _, t := range mcpTools {
			if t.Name == toolName {
				known = true
				break
			}
		}
		if !known {
			sendJSON(c, 200, rpcError(id, -32602, "unknown tool "+toolName), nil)
			return
		}
		toolArgs, _ := params["arguments"].(map[string]any)
		if toolArgs == nil {
			toolArgs = map[string]any{}
		}
		outcome := mcpCallTool(c, toolName, toolArgs)
		text, _ := json.Marshal(outcome.result)
		sendJSON(c, 200, rpcResult(id, map[string]any{
			"content":           []any{map[string]any{"type": "text", "text": string(text)}},
			"structuredContent": outcome.result,
			"isError":           outcome.isError,
		}), nil)
		return
	}
	sendJSON(c, 200, rpcError(id, -32601, "method not found: "+method), nil)
}
