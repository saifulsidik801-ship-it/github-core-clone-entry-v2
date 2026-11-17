// restface.go — the REST v3 surface: repos, branches, commits, refs, contents,
// labels, issues, pulls. One store, shared with git, GraphQL and MCP.
// A direct port of the proven Node implementation.

package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

func needAuth(c *Ctx) bool {
	if !hasAuth(c) {
		sendError(c, 401, "requires authentication")
		return false
	}
	return true
}

func resolveRepo(c *Ctx) *Repo {
	if len(c.Params) < 2 {
		return nil
	}
	owner := decodeSegment(c.Params[0])
	name := decodeSegment(c.Params[1])
	if owner == "" || name == "" {
		return nil
	}
	repo := c.Store.FindRepo(owner, name)
	if repo != nil {
		c.Store.LearnViewer(owner)
	}
	return repo
}

func hostOf(c *Ctx) string {
	if c.R.Host != "" {
		return c.R.Host
	}
	return "127.0.0.1"
}

func pageParams(c *Ctx) (page, perPage int) {
	page = 1
	perPage = 30
	if v := c.R.URL.Query().Get("page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 {
			page = n
		}
	}
	if v := c.R.URL.Query().Get("per_page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 1 {
			perPage = n
			if perPage > 100 {
				perPage = 100
			}
		}
	}
	return page, perPage
}

func sendPage(c *Ctx, items []any) {
	page, perPage := pageParams(c)
	start := (page - 1) * perPage
	if start > len(items) {
		start = len(items)
	}
	end := start + perPage
	if end > len(items) {
		end = len(items)
	}
	slice := items[start:end]
	base := "http://" + hostOf(c) + c.R.URL.Path
	var links []string
	if end < len(items) {
		links = append(links, fmt.Sprintf("<%s?page=%d&per_page=%d>; rel=\"next\"", base, page+1, perPage))
	}
	if page > 1 {
		links = append(links, fmt.Sprintf("<%s?page=%d&per_page=%d>; rel=\"prev\"", base, page-1, perPage))
	}
	links = append(links, fmt.Sprintf("<%s?page=1&per_page=%d>; rel=\"first\"", base, perPage))
	lastPage := (len(items) + perPage - 1) / perPage
	if lastPage < 1 {
		lastPage = 1
	}
	links = append(links, fmt.Sprintf("<%s?page=%d&per_page=%d>; rel=\"last\"", base, lastPage, perPage))
	sendJSON(c, 200, slice, map[string]string{"Link": strings.Join(links, ", ")})
}

func strField(b map[string]any, key string) string {
	if v, ok := b[key].(string); ok {
		return v
	}
	return ""
}

func boolField(b map[string]any, key string) bool {
	if v, ok := b[key].(bool); ok {
		return v
	}
	return false
}

// ---------------------------------------------------------------------------
// root / meta / user
// ---------------------------------------------------------------------------

func handleRoot(c *Ctx) {
	base := "http://" + hostOf(c) + "/api/v3"
	sendJSON(c, 200, map[string]any{
		"current_user_url": base + "/user",
		"rate_limit_url":   base + "/rate_limit",
	}, map[string]string{"X-OAuth-Scopes": "repo, user"})
}

func handleMeta(c *Ctx) {
	sendJSON(c, 200, map[string]any{"installed_version": "1.0.0"}, nil)
}

func handleGetUser(c *Ctx) {
	if !needAuth(c) {
		return
	}
	if c.Store.Viewer == "" {
		sendError(c, 404, "viewer not known")
		return
	}
	sendJSON(c, 200, map[string]any{"login": c.Store.Viewer, "id": 1, "type": "User"}, nil)
}

func handleListUserRepos(c *Ctx) {
	if !needAuth(c) {
		return
	}
	var repos []*Repo
	for _, r := range c.Store.Repos {
		repos = append(repos, r)
	}
	sort.Slice(repos, func(i, j int) bool { return repos[i].ID < repos[j].ID })
	items := make([]any, 0, len(repos))
	for _, r := range repos {
		items = append(items, c.Store.RepoJSON(r))
	}
	sendPage(c, items)
}

func handleCreateUserRepo(c *Ctx) {
	if !needAuth(c) {
		return
	}
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	name := strings.TrimSpace(strField(b, "name"))
	if name == "" {
		sendError(c, 422, "name is required")
		return
	}
	if c.Store.FindRepoByName(name) != nil {
		sendError(c, 422, "name already exists on this account")
		return
	}
	repo := c.Store.CreateRepo(name, boolField(b, "private"), strField(b, "description"))
	sendJSON(c, 201, c.Store.RepoJSON(repo), nil)
}

// ---------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------

func handleGetRepo(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	sendBuf(c, 200, c.Store.RepoJSONBuf(repo), nil)
}

func handlePatchRepo(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	if v, ok := b["description"].(string); ok {
		repo.Description = v
	}
	if v, ok := b["private"].(bool); ok {
		repo.Private = v
	}
	repo.UpdatedAt = c.Store.Clock.ISO()
	repo.repoJSONBuf = nil
	sendJSON(c, 200, c.Store.RepoJSON(repo), nil)
}

func handleDeleteRepo(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	c.Store.DeleteRepo(repo.Name)
	sendNoContent(c)
}

// ---------------------------------------------------------------------------
// branches / commits / refs
// ---------------------------------------------------------------------------

func handleListBranches(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	var names []string
	for r := range repo.Refs {
		if strings.HasPrefix(r, "refs/heads/") {
			names = append(names, r[len("refs/heads/"):])
		}
	}
	sort.Strings(names)
	branches := make([]any, 0, len(names))
	for _, name := range names {
		branches = append(branches, map[string]any{
			"name":      name,
			"commit":    map[string]any{"sha": repo.Refs["refs/heads/"+name]},
			"protected": false,
		})
	}
	sendJSON(c, 200, branches, nil)
}

func handleGetBranch(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	branch := decodeSegment(c.Params[2])
	oid, ok := repo.Refs["refs/heads/"+branch]
	if !ok {
		sendError(c, 404, "branch not found")
		return
	}
	sendJSON(c, 200, map[string]any{
		"name":      branch,
		"commit":    map[string]any{"sha": oid},
		"protected": false,
	}, nil)
}

func handleListCommits(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	shaParam := c.R.URL.Query().Get("sha")
	var tip string
	if shaParam != "" {
		if isObjectID(shaParam) {
			tip = shaParam
		} else {
			tip = repo.Refs["refs/heads/"+shaParam]
		}
	} else {
		tip = repo.Refs["refs/heads/"+repo.DefaultBranch]
	}
	if tip == "" {
		sendJSON(c, 200, []any{}, nil)
		return
	}
	oids := c.Store.ListCommits(tip, 100)
	out := make([]any, 0, len(oids))
	for _, o := range oids {
		if j := c.Store.CommitJSON(o); j != nil {
			out = append(out, j)
		}
	}
	sendJSON(c, 200, out, nil)
}

func handleCreateRef(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	ref := strField(b, "ref")
	sha := strField(b, "sha")
	if !strings.HasPrefix(ref, "refs/") || !isObjectID(sha) {
		sendError(c, 422, "invalid ref or sha")
		return
	}
	if _, ok := c.Store.Objects[sha]; !ok {
		sendError(c, 422, "sha does not exist")
		return
	}
	if _, ok := repo.Refs[ref]; ok {
		sendError(c, 422, "ref already exists")
		return
	}
	repo.Refs[ref] = sha
	repo.Rev++
	repo.repoJSONBuf = nil
	sendJSON(c, 201, map[string]any{"ref": ref, "object": map[string]any{"sha": sha}}, nil)
}

func handleGetRef(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	branch := decodeSegment(c.Params[2])
	oid, ok := repo.Refs["refs/heads/"+branch]
	if !ok {
		sendError(c, 404, "reference not found")
		return
	}
	sendJSON(c, 200, map[string]any{"ref": "refs/heads/" + branch, "object": map[string]any{"sha": oid}}, nil)
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

// subtreeOID returns the tree oid at path under a root tree, or "".
func subtreeOID(store *Store, rootTree, path string) string {
	if path == "" {
		return rootTree
	}
	oid := rootTree
	for _, seg := range strings.Split(path, "/") {
		if oid == "" {
			return ""
		}
		obj := store.Objects[oid]
		if obj == nil || obj.Type != ObjTree {
			return ""
		}
		entries, _ := parseTree(obj.Data)
		var found *TreeEntry
		for i := range entries {
			if entries[i].Name == seg {
				found = &entries[i]
				break
			}
		}
		if found == nil || found.Mode != "40000" {
			return ""
		}
		oid = found.OID
	}
	return oid
}

func dirEntry(store *Store, parentPath string, e TreeEntry) map[string]any {
	path := e.Name
	if parentPath != "" {
		path = parentPath + "/" + e.Name
	}
	if e.Mode == "40000" {
		return map[string]any{"type": "dir", "name": e.Name, "path": path, "sha": e.OID, "size": 0}
	}
	size := 0
	if blob := store.Objects[e.OID]; blob != nil {
		size = len(blob.Data)
	}
	return map[string]any{"type": "file", "name": e.Name, "path": path, "sha": e.OID, "size": size}
}

func handlePutContents(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	path := decodeSegment(c.Params[2])
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	message := strField(b, "message")
	if message == "" {
		message = "update"
	}
	contentB64 := strField(b, "content")
	if contentB64 == "" {
		sendError(c, 422, "content is required")
		return
	}
	data, err := base64Decode(contentB64)
	if err != nil {
		sendError(c, 422, "content is not valid base64")
		return
	}
	branch := strField(b, "branch")
	if branch == "" {
		branch = repo.DefaultBranch
	}
	sha := strField(b, "sha")
	res, status, msg := c.Store.WriteContents(repo, branch, path, data, message, sha)
	if res == nil {
		sendError(c, status, msg)
		return
	}
	name := path
	if i := strings.LastIndex(path, "/"); i >= 0 {
		name = path[i+1:]
	}
	code := 200
	if res.Created {
		code = 201
	}
	sendJSON(c, code, map[string]any{
		"content": map[string]any{"name": name, "path": path, "sha": res.BlobOID, "size": len(data), "encoding": "base64"},
		"commit":  map[string]any{"sha": res.CommitOID},
	}, nil)
}

func handleGetContents(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	path := ""
	if len(c.Params) > 2 {
		path = decodeSegment(c.Params[2])
	}
	refParam := c.R.URL.Query().Get("ref")
	var tip string
	if refParam != "" {
		if isObjectID(refParam) {
			tip = refParam
		} else {
			tip = repo.Refs["refs/heads/"+refParam]
		}
	} else {
		tip = repo.Refs["refs/heads/"+repo.DefaultBranch]
	}
	if tip == "" {
		sendError(c, 404, "repository is empty")
		return
	}
	obj := c.Store.Objects[tip]
	if obj == nil || obj.Type != ObjCommit {
		sendError(c, 404, "repository is empty")
		return
	}
	rootTree := parseCommit(obj.Data).Tree
	owner := c.Store.ownerOf(repo)
	if path == "" {
		entries, _ := parseTree(rootTreeBytes(c.Store, rootTree))
		out := make([]any, 0, len(entries))
		for _, e := range entries {
			out = append(out, dirEntry(c.Store, "", e))
		}
		sendJSON(c, 200, out, nil)
		return
	}
	if blobOID := c.Store.TreeBlobAt(rootTree, path); blobOID != "" {
		blob := c.Store.Objects[blobOID]
		var data []byte
		if blob != nil {
			data = blob.Data
		}
		b64 := base64Encode(data)
		var wrapped strings.Builder
		for i := 0; i < len(b64); i += 60 {
			end := i + 60
			if end > len(b64) {
				end = len(b64)
			}
			wrapped.WriteString(b64[i:end])
			wrapped.WriteString("\n")
		}
		name := path
		if i := strings.LastIndex(path, "/"); i >= 0 {
			name = path[i+1:]
		}
		sendJSON(c, 200, map[string]any{
			"type":         "file",
			"encoding":     "base64",
			"size":         len(data),
			"name":         name,
			"path":         path,
			"content":      wrapped.String(),
			"sha":          blobOID,
			"url":          "/api/v3/repos/" + owner + "/" + repo.Name + "/contents/" + path,
			"html_url":     "https://example.invalid/" + owner + "/" + repo.Name + "/blob/" + repo.DefaultBranch + "/" + path,
			"git_url":      "/api/v3/repos/" + owner + "/" + repo.Name + "/git/blobs/" + blobOID,
			"download_url": "https://example.invalid/" + owner + "/" + repo.Name + "/raw/" + repo.DefaultBranch + "/" + path,
		}, nil)
		return
	}
	dirOID := subtreeOID(c.Store, rootTree, path)
	if dirOID == "" {
		sendError(c, 404, "path not found")
		return
	}
	entries, _ := parseTree(rootTreeBytes(c.Store, dirOID))
	out := make([]any, 0, len(entries))
	for _, e := range entries {
		out = append(out, dirEntry(c.Store, path, e))
	}
	sendJSON(c, 200, out, nil)
}

func rootTreeBytes(store *Store, oid string) []byte {
	if obj := store.Objects[oid]; obj != nil {
		return obj.Data
	}
	return nil
}

func handleDeleteContents(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	path := decodeSegment(c.Params[2])
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	message := strField(b, "message")
	if message == "" {
		message = "delete"
	}
	branch := strField(b, "branch")
	if branch == "" {
		branch = repo.DefaultBranch
	}
	sha := strField(b, "sha")
	res, status, msg := c.Store.DeleteContents(repo, branch, path, message, sha)
	if res == nil {
		sendError(c, status, msg)
		return
	}
	sendJSON(c, 200, map[string]any{"commit": map[string]any{"sha": res.CommitOID}}, nil)
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

func handleCreateLabel(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	name := strings.TrimSpace(strField(b, "name"))
	color := strField(b, "color")
	if color == "" {
		color = "ededed"
	}
	if name == "" {
		sendError(c, 422, "name is required")
		return
	}
	if _, exists := repo.Labels[name]; exists {
		sendError(c, 422, "label already exists")
		return
	}
	label := &Label{ID: c.Store.NextLabelID(), Name: name, Color: color, Description: strField(b, "description")}
	repo.Labels[name] = label
	sendJSON(c, 201, LabelJSON(label), nil)
}

func handleListLabels(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	out := make([]any, 0, len(repo.Labels))
	for _, l := range repo.Labels {
		out = append(out, LabelJSON(l))
	}
	sendJSON(c, 200, out, nil)
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

func findIssue(repo *Repo, n int) *Issue {
	for _, i := range repo.Issues {
		if i.Number == n {
			return i
		}
	}
	return nil
}

func issueNumber(c *Ctx) int {
	n, _ := strconv.Atoi(c.Params[2])
	return n
}

func handleCreateIssue(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	title := strField(b, "title")
	bodyText := strField(b, "body")
	var labels []string
	if arr, ok := b["labels"].([]any); ok {
		for _, x := range arr {
			if s, ok := x.(string); ok {
				labels = append(labels, s)
			}
		}
	}
	if title == "" {
		sendError(c, 422, "title is required")
		return
	}
	issue, errMsg := c.Store.CreateIssue(repo, title, bodyText, labels)
	if issue == nil {
		sendError(c, 422, errMsg)
		return
	}
	sendJSON(c, 201, c.Store.IssueJSON(repo, issue), nil)
}

func handleListIssues(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	state := c.R.URL.Query().Get("state")
	if state == "" {
		state = "open"
	}
	var items []*Issue
	for _, i := range repo.Issues {
		if state == "all" || i.State == state {
			items = append(items, i)
		}
	}
	direction := c.R.URL.Query().Get("direction")
	sort.Slice(items, func(a, b int) bool {
		if direction == "asc" {
			return items[a].Number < items[b].Number
		}
		return items[a].Number > items[b].Number
	})
	out := make([]any, 0, len(items))
	for _, i := range items {
		out = append(out, c.Store.IssueJSON(repo, i))
	}
	sendPage(c, out)
}

func handleGetIssue(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	issue := findIssue(repo, issueNumber(c))
	if issue == nil {
		sendError(c, 404, "issue not found")
		return
	}
	// The read workload's fast path: a precomputed response buffer.
	sendBuf(c, 200, c.Store.IssueJSONBuf(repo, issue), nil)
}

func handlePatchIssue(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	issue := findIssue(repo, issueNumber(c))
	if issue == nil {
		sendError(c, 404, "issue not found")
		return
	}
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	if v, ok := b["title"].(string); ok {
		issue.Title = v
	}
	if v, ok := b["body"].(string); ok {
		issue.Body = v
	}
	if v, ok := b["state"].(string); ok && (v == "open" || v == "closed") {
		issue.State = v
	}
	if arr, ok := b["labels"].([]any); ok {
		var labels []*Label
		for _, x := range arr {
			s, ok := x.(string)
			if !ok {
				continue
			}
			l, ok := repo.Labels[s]
			if !ok {
				sendError(c, 422, "label "+s+" does not exist")
				return
			}
			labels = append(labels, l)
		}
		issue.Labels = labels
	}
	issue.UpdatedAt = c.Store.Clock.ISO()
	issue.jsonBuf = nil
	sendJSON(c, 200, c.Store.IssueJSON(repo, issue), nil)
}

func handleCreateComment(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	issue := findIssue(repo, issueNumber(c))
	if issue == nil {
		sendError(c, 404, "issue not found")
		return
	}
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	now := c.Store.Clock.ISO()
	comment := &Comment{ID: repo.NextCommentID, Body: strField(b, "body"), CreatedAt: now, UpdatedAt: now}
	repo.NextCommentID++
	repo.Comments[issue.Number] = append(repo.Comments[issue.Number], comment)
	issue.jsonBuf = nil
	sendJSON(c, 201, c.Store.CommentJSON(repo, issue.Number, comment), nil)
}

func handleListComments(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	issue := findIssue(repo, issueNumber(c))
	if issue == nil {
		sendError(c, 404, "issue not found")
		return
	}
	list := repo.Comments[issue.Number]
	out := make([]any, 0, len(list))
	for _, cm := range list {
		out = append(out, c.Store.CommentJSON(repo, issue.Number, cm))
	}
	sendJSON(c, 200, out, nil)
}

// ---------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------

func findPull(repo *Repo, n int) *Pull {
	for _, p := range repo.Pulls {
		if p.Number == n {
			return p
		}
	}
	return nil
}

func handleCreatePull(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	b, ok := bodyMap(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	title := strField(b, "title")
	bodyText := strField(b, "body")
	head := strField(b, "head")
	base := strField(b, "base")
	if base == "" {
		base = repo.DefaultBranch
	}
	if title == "" || head == "" {
		sendError(c, 422, "title and head are required")
		return
	}
	pr, errMsg := c.Store.CreatePull(repo, title, bodyText, head, base)
	if pr == nil {
		sendError(c, 422, errMsg)
		return
	}
	sendJSON(c, 201, c.Store.PullJSON(repo, pr), nil)
}

func handleListPulls(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	state := c.R.URL.Query().Get("state")
	if state == "" {
		state = "open"
	}
	var items []*Pull
	for _, p := range repo.Pulls {
		if state == "all" || p.State == state {
			items = append(items, p)
		}
	}
	sort.Slice(items, func(a, b int) bool { return items[a].Number > items[b].Number })
	out := make([]any, 0, len(items))
	for _, p := range items {
		out = append(out, c.Store.PullJSON(repo, p))
	}
	sendPage(c, out)
}

func handleGetPull(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	pr := findPull(repo, issueNumber(c))
	if pr == nil {
		sendError(c, 404, "pull request not found")
		return
	}
	sendJSON(c, 200, c.Store.PullJSON(repo, pr), nil)
}

func handleListPullFiles(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	pr := findPull(repo, issueNumber(c))
	if pr == nil {
		sendError(c, 404, "pull request not found")
		return
	}
	out := make([]any, 0, len(pr.Files))
	for _, f := range pr.Files {
		out = append(out, map[string]any{
			"filename": f.Filename, "status": f.Status,
			"additions": f.Additions, "deletions": f.Deletions, "changes": f.Changes,
		})
	}
	sendJSON(c, 200, out, nil)
}

func handleMergePull(c *Ctx) {
	if !needAuth(c) {
		return
	}
	repo := resolveRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	pr := findPull(repo, issueNumber(c))
	if pr == nil {
		sendError(c, 404, "pull request not found")
		return
	}
	if _, ok := bodyMap(c); !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	if pr.State != "open" {
		sendError(c, 409, "pull request is not open")
		return
	}
	if PrHasConflict(c.Store, repo, pr) {
		sendError(c, 405, "merge conflict")
		return
	}
	oid, errMsg := c.Store.MergePull(repo, pr)
	if oid == "" {
		sendError(c, 405, errMsg)
		return
	}
	sendJSON(c, 200, map[string]any{"merged": true, "sha": oid, "message": "Pull request #" + strconv.Itoa(pr.Number) + " merged"}, nil)
}
