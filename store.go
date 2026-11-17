// store.go — the forge's whole in-memory model: objects, repos, issues, pulls,
// labels, comments, the deterministic clock, and the response caches that make
// the hot paths fast. No I/O, no wall clock: every timestamp comes from the
// seeded counter, so a replayed trial leaves byte-identical state.
// A direct port of the proven Node implementation.

package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// clock
// ---------------------------------------------------------------------------

const epochDefault = 1735689600 // 2025-01-01T00:00:00Z

func seedEpoch() int64 {
	raw := os.Getenv("MAKEFUN_TRIAL_NOW")
	if raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			if n > 1e12 {
				return n / 1000
			}
			return n
		}
		if f, err := strconv.ParseFloat(raw, 64); err == nil && f > 0 {
			if f > 1e12 {
				return int64(f) / 1000
			}
			return int64(f)
		}
	}
	return epochDefault
}

// Clock is deterministic: every stamp the server emits comes from this counter.
type Clock struct {
	sec int64
}

func NewClock() *Clock { return &Clock{sec: seedEpoch()} }

// Next returns the next second as a Unix timestamp.
func (c *Clock) Next() int64 {
	v := c.sec
	c.sec++
	return v
}

func (c *Clock) ISO() string { return c.ISOAt(c.Next()) }

func (c *Clock) ISOAt(sec int64) string {
	return time.Unix(sec, 0).UTC().Format("2006-01-02T15:04:05.000Z")
}

// ---------------------------------------------------------------------------
// global ids (opaque, stable)
// ---------------------------------------------------------------------------

func b64url(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

func repoGlobalID(owner, name string) string    { return b64url("Repository:" + owner + "/" + name) }
func issueGlobalID(owner, repo string, n int) string {
	return b64url(fmt.Sprintf("Issue:%s/%s:%d", owner, repo, n))
}
func pullGlobalID(owner, repo string, n int) string {
	return b64url(fmt.Sprintf("PullRequest:%s/%s:%d", owner, repo, n))
}
func commentGlobalID(owner, repo string, issueNumber, id int) string {
	return b64url(fmt.Sprintf("IssueComment:%s/%s:%d:%d", owner, repo, issueNumber, id))
}

type DecodedID struct {
	Kind  string
	Owner string
	Repo  string
	Number int
	Extra  int
}

var globalIDRe = regexp.MustCompile(`^(Repository|Issue|PullRequest|IssueComment):([^/]+)/([^:]+)(?::(\d+))?(?::(\d+))?$`)

func decodeGlobalID(id string) *DecodedID {
	raw, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		return nil
	}
	m := globalIDRe.FindStringSubmatch(string(raw))
	if m == nil {
		return nil
	}
	d := &DecodedID{Kind: m[1], Owner: m[2], Repo: m[3]}
	if m[4] != "" {
		d.Number, _ = strconv.Atoi(m[4])
	}
	if m[5] != "" {
		d.Extra, _ = strconv.Atoi(m[5])
	}
	return d
}

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

type Label struct {
	ID          int
	Name        string
	Color       string
	Description string
}

type Issue struct {
	ID        int
	Number    int
	Title     string
	Body      string
	State     string // "open" | "closed"
	Labels    []*Label
	CreatedAt string
	UpdatedAt string
	Seq       int
	// jsonBuf is the precomputed GET-one response bytes (the read workload
	// hammers this).
	jsonBuf []byte
}

type Comment struct {
	ID        int
	Body      string
	CreatedAt string
	UpdatedAt string
}

type PullFile struct {
	Filename  string
	Status    string // "added" | "modified" | "removed"
	Additions int
	Deletions int
	Changes   int
}

type Pull struct {
	ID               int
	Number           int
	Title            string
	Body             string
	State            string // "open" | "closed"
	HeadRef          string
	BaseRef          string
	HeadSHA          string
	BaseSHA          string
	Merged           bool
	MergedAt         string
	MergeCommitSHA   string
	CreatedAt        string
	UpdatedAt        string
	Seq              int
	Files            []PullFile
	HeadTreeAtCreate string
	BaseTreeAtCreate string
}

type Repo struct {
	ID            int
	Name          string
	Owner         string // "" until bound on first owner-bearing access
	Description   string
	Private       bool
	DefaultBranch string
	CreatedAt     string
	UpdatedAt     string
	Refs          map[string]string
	Issues        []*Issue
	Pulls         []*Pull
	Labels        map[string]*Label
	Comments      map[int][]*Comment
	NextNumber    int
	NextCommentID int
	// Rev bumps on any ref/object change: it invalidates the git caches.
	Rev         int
	advV2       []byte
	advV2Rev    int
	advV0Up     []byte
	advV0UpRev  int
	advV0Recv   []byte
	advV0RecvRev int
	lsRefsCache map[string][]byte
	lsRefsRev   int
	packCache   map[string][]byte
	packRev     int
	repoJSONBuf []byte
}

type Store struct {
	Clock         *Clock
	Objects       map[string]*GitObject
	Repos         map[string]*Repo // key: lower(name) — one namespace per trial
	Viewer        string
	CommitParents map[string][]string
	repoSeq       int
	globalSeq     int
	labelSeq      int
}

func NewStore() *Store {
	return &Store{
		Clock:         NewClock(),
		Objects:       map[string]*GitObject{},
		Repos:         map[string]*Repo{},
		CommitParents: map[string][]string{},
		repoSeq:       5000,
		globalSeq:     100000,
		labelSeq:      1,
	}
}

// ------------------------------------------------------------ viewer learning

// LearnViewer records the login the token names, once any owner-bearing
// access has named it.
func (s *Store) LearnViewer(login string) {
	if login != "" && s.Viewer == "" {
		s.Viewer = login
	}
}

// BindOwner binds a repo's owner on first access; false on a mismatch.
func (s *Store) BindOwner(repo *Repo, owner string) bool {
	if repo.Owner == "" {
		repo.Owner = owner
		s.LearnViewer(owner)
		return true
	}
	return repo.Owner == owner
}

// FindRepo finds a repo by owner+name, honouring the viewer binding.
// Nil when absent or foreign.
func (s *Store) FindRepo(owner, name string) *Repo {
	repo := s.Repos[strings.ToLower(name)]
	if repo == nil {
		return nil
	}
	if repo.Owner == "" {
		repo.Owner = owner
		s.LearnViewer(owner)
		return repo
	}
	if repo.Owner == owner {
		return repo
	}
	return nil
}

func (s *Store) FindRepoByName(name string) *Repo {
	return s.Repos[strings.ToLower(name)]
}

func (s *Store) CreateRepo(name string, isPrivate bool, description string) *Repo {
	now := s.Clock.ISO()
	repo := &Repo{
		ID:            s.repoSeq,
		Name:          name,
		Owner:         s.Viewer,
		Description:   description,
		Private:       isPrivate,
		DefaultBranch: "main",
		CreatedAt:     now,
		UpdatedAt:     now,
		Refs:          map[string]string{},
		Labels:        map[string]*Label{},
		Comments:      map[int][]*Comment{},
		NextNumber:    1,
		NextCommentID: 1,
		advV2Rev:      -1,
		advV0UpRev:    -1,
		advV0RecvRev:  -1,
		lsRefsCache:   map[string][]byte{},
		lsRefsRev:     -1,
		packCache:     map[string][]byte{},
		packRev:       -1,
	}
	s.repoSeq++
	s.Repos[strings.ToLower(name)] = repo
	return repo
}

func (s *Store) DeleteRepo(name string) bool {
	if _, ok := s.Repos[strings.ToLower(name)]; !ok {
		return false
	}
	delete(s.Repos, strings.ToLower(name))
	return true
}

func (s *Store) NextIssueID() int { id := s.globalSeq; s.globalSeq++; return id }
func (s *Store) NextPullID() int  { id := s.globalSeq; s.globalSeq++; return id }
func (s *Store) NextLabelID() int { id := s.labelSeq; s.labelSeq++; return id }

// ------------------------------------------------------------ objects

func (s *Store) Lookup(oid string) *GitObject { return s.Objects[oid] }

func (s *Store) PutObject(typ GitObjectType, data []byte) string {
	oid := hashObject(typ, data)
	if _, ok := s.Objects[oid]; !ok {
		s.Objects[oid] = &GitObject{Type: typ, Data: data}
		if typ == ObjCommit {
			s.CommitParents[oid] = parseCommit(data).Parents
		}
	}
	return oid
}

// PutObjectWithID stores an object whose id is already known (pack ingestion).
func (s *Store) PutObjectWithID(oid string, obj *GitObject) {
	if _, ok := s.Objects[oid]; ok {
		return
	}
	s.Objects[oid] = obj
	if obj.Type == ObjCommit {
		s.CommitParents[oid] = parseCommit(obj.Data).Parents
	}
}

func (s *Store) PutBlob(data []byte) string { return s.PutObject(ObjBlob, data) }

// MakeCommit builds a commit object; the message gets git's trailing newline.
func (s *Store) MakeCommit(tree string, parents []string, message string) string {
	msg := message
	if !strings.HasSuffix(msg, "\n") {
		msg += "\n"
	}
	ts := s.Clock.Next()
	who := "Forge <forge@example.invalid>"
	data := buildCommit(tree, parents, msg, who, who, ts)
	return s.PutObject(ObjCommit, data)
}

// ------------------------------------------------------------ trees

// EditTree returns the tree with segments set to blobOID (or removed when "").
func (s *Store) EditTree(rootOID string, segments []string, blobOID string, mode string) string {
	if len(segments) == 0 {
		panic("empty tree path")
	}
	head := segments[0]
	rest := segments[1:]
	var entries []TreeEntry
	if rootOID != "" {
		if obj := s.Objects[rootOID]; obj != nil {
			entries, _ = parseTree(obj.Data)
		}
	}
	var kept []TreeEntry
	for _, e := range entries {
		if e.Name != head {
			kept = append(kept, e)
		}
	}
	if len(rest) == 0 {
		if blobOID != "" {
			kept = append(kept, TreeEntry{Mode: mode, Name: head, OID: blobOID})
		}
	} else {
		var existing *TreeEntry
		for i := range entries {
			if entries[i].Name == head && entries[i].Mode == "40000" {
				existing = &entries[i]
				break
			}
		}
		var childOID string
		if existing != nil {
			childOID = s.EditTree(existing.OID, rest, blobOID, mode)
		} else {
			childOID = s.EditTree("", rest, blobOID, mode)
		}
		if child := s.Objects[childOID]; child != nil {
			if childEntries, _ := parseTree(child.Data); len(childEntries) > 0 {
				kept = append(kept, TreeEntry{Mode: "40000", Name: head, OID: childOID})
			}
		}
	}
	return s.PutObject(ObjTree, buildTree(kept))
}

// FlattenTree maps path -> {oid, mode} for every blob under a tree.
type flatEntry struct {
	OID  string
	Mode string
}

func (s *Store) FlattenTree(treeOID string) map[string]flatEntry {
	out := map[string]flatEntry{}
	var walk func(oid, prefix string)
	walk = func(oid, prefix string) {
		obj := s.Objects[oid]
		if obj == nil || obj.Type != ObjTree {
			return
		}
		entries, _ := parseTree(obj.Data)
		for _, e := range entries {
			path := e.Name
			if prefix != "" {
				path = prefix + "/" + e.Name
			}
			if e.Mode == "40000" {
				walk(e.OID, path)
			} else {
				out[path] = flatEntry{OID: e.OID, Mode: e.Mode}
			}
		}
	}
	walk(treeOID, "")
	return out
}

// TreeBlobAt returns the blob oid at path under a tree, or "".
func (s *Store) TreeBlobAt(treeOID, path string) string {
	segments := strings.Split(path, "/")
	oid := treeOID
	for i, seg := range segments {
		if oid == "" {
			return ""
		}
		obj := s.Objects[oid]
		if obj == nil || obj.Type != ObjTree {
			return ""
		}
		entries, _ := parseTree(obj.Data)
		var found *TreeEntry
		for j := range entries {
			if entries[j].Name == seg {
				found = &entries[j]
				break
			}
		}
		if found == nil {
			return ""
		}
		if i == len(segments)-1 {
			if found.Mode == "40000" {
				return ""
			}
			return found.OID
		}
		if found.Mode != "40000" {
			return ""
		}
		oid = found.OID
	}
	return ""
}

// BlobLines returns the lines of a blob, for diff counts.
func (s *Store) BlobLines(oid string) []string {
	obj := s.Objects[oid]
	if obj == nil {
		return nil
	}
	text := string(obj.Data)
	if text == "" {
		return nil
	}
	lines := strings.Split(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// LineDiff counts additions/deletions between two blobs (multiset difference).
func (s *Store) LineDiff(oldOID, newOID string) (additions, deletions int) {
	var oldLines, newLines []string
	if oldOID != "" {
		oldLines = s.BlobLines(oldOID)
	}
	if newOID != "" {
		newLines = s.BlobLines(newOID)
	}
	oldCount := map[string]int{}
	for _, l := range oldLines {
		oldCount[l]++
	}
	for _, l := range newLines {
		if c := oldCount[l]; c > 0 {
			oldCount[l] = c - 1
		} else {
			additions++
		}
	}
	for _, c := range oldCount {
		deletions += c
	}
	return additions, deletions
}

// DiffTrees returns the changed files between two trees.
func (s *Store) DiffTrees(oldTree, newTree string) []PullFile {
	var oldMap, newMap map[string]flatEntry
	if oldTree != "" {
		oldMap = s.FlattenTree(oldTree)
	} else {
		oldMap = map[string]flatEntry{}
	}
	if newTree != "" {
		newMap = s.FlattenTree(newTree)
	} else {
		newMap = map[string]flatEntry{}
	}
	paths := map[string]bool{}
	for p := range oldMap {
		paths[p] = true
	}
	for p := range newMap {
		paths[p] = true
	}
	var sorted []string
	for p := range paths {
		sorted = append(sorted, p)
	}
	sort.Strings(sorted)
	var files []PullFile
	for _, path := range sorted {
		o, hasO := oldMap[path]
		n, hasN := newMap[path]
		switch {
		case hasO && !hasN:
			_, d := s.LineDiff(o.OID, "")
			files = append(files, PullFile{Filename: path, Status: "removed", Additions: 0, Deletions: d, Changes: d})
		case !hasO && hasN:
			a, _ := s.LineDiff("", n.OID)
			files = append(files, PullFile{Filename: path, Status: "added", Additions: a, Deletions: 0, Changes: a})
		case hasO && hasN && o.OID != n.OID:
			a, d := s.LineDiff(o.OID, n.OID)
			files = append(files, PullFile{Filename: path, Status: "modified", Additions: a, Deletions: d, Changes: a + d})
		}
	}
	return files
}

// ---------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------

func marshalJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return append(b, '\n')
}

func (s *Store) ownerOf(repo *Repo) string {
	if repo.Owner != "" {
		return repo.Owner
	}
	return s.Viewer
}

// RepoJSON is the GitHub repository object (a superset of what the suite reads).
func (s *Store) RepoJSON(repo *Repo) map[string]any {
	owner := s.ownerOf(repo)
	return map[string]any{
		"id":             repo.ID,
		"name":           repo.Name,
		"full_name":      owner + "/" + repo.Name,
		"owner":          map[string]any{"login": owner, "id": repo.ID, "type": "User"},
		"private":        repo.Private,
		"description":    repo.Description,
		"default_branch": repo.DefaultBranch,
		"created_at":     repo.CreatedAt,
		"updated_at":     repo.UpdatedAt,
		"pushed_at":      repo.UpdatedAt,
		"has_issues":     true,
		"has_projects":   true,
		"has_wiki":       true,
		"fork":           false,
		"archived":       false,
		"disabled":       false,
		"visibility":     map[bool]string{true: "private", false: "public"}[repo.Private],
		"html_url":       "https://example.invalid/" + owner + "/" + repo.Name,
		"url":            "/api/v3/repos/" + owner + "/" + repo.Name,
		"clone_url":      "https://example.invalid/" + owner + "/" + repo.Name + ".git",
	}
}

func (s *Store) RepoJSONBuf(repo *Repo) []byte {
	if repo.repoJSONBuf != nil {
		return repo.repoJSONBuf
	}
	buf := marshalJSON(s.RepoJSON(repo))
	repo.repoJSONBuf = buf
	return buf
}

func LabelJSON(l *Label) map[string]any {
	return map[string]any{"id": l.ID, "name": l.Name, "color": l.Color, "description": l.Description, "default": false}
}

func (s *Store) IssueJSON(repo *Repo, issue *Issue) map[string]any {
	owner := s.ownerOf(repo)
	labels := make([]any, 0, len(issue.Labels))
	for _, l := range issue.Labels {
		labels = append(labels, LabelJSON(l))
	}
	var closedAt any
	if issue.State == "closed" {
		closedAt = issue.UpdatedAt
	}
	return map[string]any{
		"id":         issue.ID,
		"number":     issue.Number,
		"title":      issue.Title,
		"body":       issue.Body,
		"state":      issue.State,
		"labels":     labels,
		"user":       map[string]any{"login": owner, "id": repo.ID, "type": "User"},
		"created_at": issue.CreatedAt,
		"updated_at": issue.UpdatedAt,
		"closed_at":  closedAt,
		"html_url":   "https://example.invalid/" + owner + "/" + repo.Name + "/issues/" + strconv.Itoa(issue.Number),
		"url":        "/api/v3/repos/" + owner + "/" + repo.Name + "/issues/" + strconv.Itoa(issue.Number),
		"comments":   len(repo.Comments[issue.Number]),
	}
}

// IssueJSONBuf is the cached GET-one bytes for an issue; rebuilt on any change.
func (s *Store) IssueJSONBuf(repo *Repo, issue *Issue) []byte {
	if issue.jsonBuf != nil {
		return issue.jsonBuf
	}
	buf := marshalJSON(s.IssueJSON(repo, issue))
	issue.jsonBuf = buf
	return buf
}

func (s *Store) CommentJSON(repo *Repo, issueNumber int, c *Comment) map[string]any {
	owner := s.ownerOf(repo)
	return map[string]any{
		"id":         c.ID,
		"body":       c.Body,
		"user":       map[string]any{"login": owner, "id": repo.ID, "type": "User"},
		"created_at": c.CreatedAt,
		"updated_at": c.UpdatedAt,
		"html_url":   "https://example.invalid/" + owner + "/" + repo.Name + "/issues/" + strconv.Itoa(issueNumber) + "#issuecomment-" + strconv.Itoa(c.ID),
		"url":        "/api/v3/repos/" + owner + "/" + repo.Name + "/issues/" + strconv.Itoa(issueNumber) + "/comments/" + strconv.Itoa(c.ID),
	}
}

func (s *Store) PullJSON(repo *Repo, pr *Pull) map[string]any {
	owner := s.ownerOf(repo)
	var closedAt any
	if pr.State == "closed" {
		closedAt = pr.UpdatedAt
	}
	var mergedAt any
	if pr.MergedAt != "" {
		mergedAt = pr.MergedAt
	}
	var mergeSHA any
	if pr.MergeCommitSHA != "" {
		mergeSHA = pr.MergeCommitSHA
	}
	return map[string]any{
		"id":     pr.ID,
		"number": pr.Number,
		"title":  pr.Title,
		"body":   pr.Body,
		"state":  pr.State,
		"head": map[string]any{
			"ref": pr.HeadRef, "sha": pr.HeadSHA, "label": owner + ":" + pr.HeadRef,
			"repo": map[string]any{"name": repo.Name, "full_name": owner + "/" + repo.Name},
		},
		"base": map[string]any{
			"ref": pr.BaseRef, "sha": pr.BaseSHA, "label": owner + ":" + pr.BaseRef,
			"repo": map[string]any{"name": repo.Name, "full_name": owner + "/" + repo.Name},
		},
		"merged":          pr.Merged,
		"merged_at":       mergedAt,
		"merge_commit_sha": mergeSHA,
		"mergeable":       pr.Merged || !PrHasConflict(s, repo, pr),
		"user":            map[string]any{"login": owner, "id": repo.ID, "type": "User"},
		"created_at":      pr.CreatedAt,
		"updated_at":      pr.UpdatedAt,
		"closed_at":       closedAt,
		"html_url":        "https://example.invalid/" + owner + "/" + repo.Name + "/pull/" + strconv.Itoa(pr.Number),
		"url":             "/api/v3/repos/" + owner + "/" + repo.Name + "/pulls/" + strconv.Itoa(pr.Number),
	}
}

func (s *Store) CommitJSON(commitOID string) map[string]any {
	obj := s.Objects[commitOID]
	if obj == nil || obj.Type != ObjCommit {
		return nil
	}
	c := parseCommit(obj.Data)
	parseWho := func(line string) map[string]any {
		re := regexp.MustCompile(`^(.*) <([^>]*)> (\d+) ([+-]\d{4})$`)
		m := re.FindStringSubmatch(line)
		if m == nil {
			return map[string]any{"name": line, "email": "", "date": ""}
		}
		ts, _ := strconv.ParseInt(m[3], 10, 64)
		return map[string]any{"name": m[1], "email": m[2], "date": s.Clock.ISOAt(ts)}
	}
	author := parseWho(c.Author)
	committer := parseWho(c.Committer)
	parents := make([]any, 0, len(c.Parents))
	for _, p := range c.Parents {
		parents = append(parents, map[string]any{"sha": p})
	}
	return map[string]any{
		"sha": commitOID,
		"commit": map[string]any{
			"message":   strings.TrimRight(c.Message, "\n"),
			"author":    author,
			"committer": committer,
			"tree":      map[string]any{"sha": c.Tree},
		},
		"author":    map[string]any{"login": "", "name": author["name"], "email": author["email"]},
		"committer": map[string]any{"login": "", "name": committer["name"], "email": committer["email"]},
		"parents":   parents,
	}
}

// ---------------------------------------------------------------------------
// issues / pulls
// ---------------------------------------------------------------------------

func (s *Store) CreateIssue(repo *Repo, title, body string, labelNames []string) (*Issue, string) {
	var labels []*Label
	for _, name := range labelNames {
		l, ok := repo.Labels[name]
		if !ok {
			return nil, "label " + name + " does not exist"
		}
		labels = append(labels, l)
	}
	now := s.Clock.ISO()
	issue := &Issue{
		ID:        s.NextIssueID(),
		Number:    repo.NextNumber,
		Title:     title,
		Body:      body,
		State:     "open",
		Labels:    labels,
		CreatedAt: now,
		UpdatedAt: now,
		Seq:       len(repo.Issues),
	}
	repo.NextNumber++
	repo.Issues = append(repo.Issues, issue)
	return issue, ""
}

func (s *Store) CreatePull(repo *Repo, title, body, headRef, baseRef string) (*Pull, string) {
	headOID, ok := repo.Refs["refs/heads/"+headRef]
	if !ok {
		return nil, "head branch " + headRef + " does not exist"
	}
	baseOID, ok := repo.Refs["refs/heads/"+baseRef]
	if !ok {
		return nil, "base branch " + baseRef + " does not exist"
	}
	for _, existing := range repo.Pulls {
		if existing.State == "open" && existing.HeadRef == headRef && existing.BaseRef == baseRef {
			return nil, "a pull request is already open for this head and base"
		}
	}
	headObj := s.Objects[headOID]
	baseObj := s.Objects[baseOID]
	if headObj == nil || headObj.Type != ObjCommit || baseObj == nil || baseObj.Type != ObjCommit {
		return nil, "head or base does not point at a commit"
	}
	headTree := parseCommit(headObj.Data).Tree
	baseTree := parseCommit(baseObj.Data).Tree
	now := s.Clock.ISO()
	pr := &Pull{
		ID:               s.NextPullID(),
		Number:           repo.NextNumber,
		Title:            title,
		Body:             body,
		State:            "open",
		HeadRef:          headRef,
		BaseRef:          baseRef,
		HeadSHA:          headOID,
		BaseSHA:          baseOID,
		CreatedAt:        now,
		UpdatedAt:        now,
		Seq:              len(repo.Pulls),
		Files:            s.DiffTrees(baseTree, headTree),
		HeadTreeAtCreate: headTree,
		BaseTreeAtCreate: baseTree,
	}
	repo.NextNumber++
	repo.Pulls = append(repo.Pulls, pr)
	return pr, ""
}

// PrHasConflict reports whether merging pr now would conflict: a path the head
// changed was also changed on the base since creation.
func PrHasConflict(s *Store, repo *Repo, pr *Pull) bool {
	baseOID, ok := repo.Refs["refs/heads/"+pr.BaseRef]
	if !ok || baseOID == pr.BaseSHA {
		return false
	}
	baseObj := s.Objects[baseOID]
	createBaseObj := s.Objects[pr.BaseSHA]
	if baseObj == nil || baseObj.Type != ObjCommit || createBaseObj == nil || createBaseObj.Type != ObjCommit {
		return false
	}
	currentBaseTree := parseCommit(baseObj.Data).Tree
	changedOnBase := s.DiffTrees(pr.BaseTreeAtCreate, currentBaseTree)
	if len(changedOnBase) == 0 {
		return false
	}
	headChanged := map[string]bool{}
	for _, f := range pr.Files {
		headChanged[f.Filename] = true
	}
	for _, f := range changedOnBase {
		if headChanged[f.Filename] {
			return true
		}
	}
	return false
}

// MergePull squash-merges pr onto its base branch. It returns the merge commit
// oid, or an error string.
func (s *Store) MergePull(repo *Repo, pr *Pull) (string, string) {
	if pr.State != "open" {
		return "", "pull request is not open"
	}
	if PrHasConflict(s, repo, pr) {
		return "", "merge conflict"
	}
	baseOID, ok := repo.Refs["refs/heads/"+pr.BaseRef]
	if !ok {
		return "", "base branch does not exist"
	}
	baseObj := s.Objects[baseOID]
	if baseObj == nil || baseObj.Type != ObjCommit {
		return "", "base does not point at a commit"
	}
	baseTree := parseCommit(baseObj.Data).Tree
	tree := baseTree
	headFlat := s.FlattenTree(pr.HeadTreeAtCreate)
	for _, file := range pr.Files {
		if file.Status == "removed" {
			tree = s.EditTree(tree, strings.Split(file.Filename, "/"), "", "100644")
		} else if entry, ok := headFlat[file.Filename]; ok {
			tree = s.EditTree(tree, strings.Split(file.Filename, "/"), entry.OID, entry.Mode)
		}
	}
	mergeOID := s.MakeCommit(tree, []string{baseOID}, "Merge pull request #"+strconv.Itoa(pr.Number)+" from "+pr.HeadRef)
	repo.Refs["refs/heads/"+pr.BaseRef] = mergeOID
	repo.Rev++
	repo.repoJSONBuf = nil
	now := s.Clock.ISO()
	pr.State = "closed"
	pr.Merged = true
	pr.MergedAt = now
	pr.MergeCommitSHA = mergeOID
	pr.UpdatedAt = now
	return mergeOID, ""
}

// ---------------------------------------------------------------------------
// contents commits
// ---------------------------------------------------------------------------

type ContentsResult struct {
	CommitOID string
	BlobOID   string
	Created   bool
}

// WriteContents creates or updates a file on a branch (creating the branch
// from the default tip when needed).
func (s *Store) WriteContents(repo *Repo, branchName, path string, data []byte, message, expectedSHA string) (*ContentsResult, int, string) {
	ref := "refs/heads/" + branchName
	tip, ok := repo.Refs[ref]
	createdBranch := false
	if !ok {
		if defaultTip, ok2 := repo.Refs["refs/heads/"+repo.DefaultBranch]; ok2 {
			tip = defaultTip
			createdBranch = true
			ok = true
		}
	}
	isNewFile := true
	if ok {
		if obj := s.Objects[tip]; obj != nil {
			isNewFile = s.TreeBlobAt(parseCommit(obj.Data).Tree, path) == ""
		}
	}
	if expectedSHA != "" {
		if !ok {
			return nil, 409, "file does not exist"
		}
		obj := s.Objects[tip]
		current := ""
		if obj != nil {
			current = s.TreeBlobAt(parseCommit(obj.Data).Tree, path)
		}
		if current != expectedSHA {
			return nil, 409, "sha does not match the current file"
		}
	}
	blobOID := s.PutBlob(data)
	var parentTree string
	var parents []string
	if ok {
		if obj := s.Objects[tip]; obj != nil {
			parentTree = parseCommit(obj.Data).Tree
		}
		parents = []string{tip}
	}
	newTree := s.EditTree(parentTree, strings.Split(path, "/"), blobOID, "100644")
	commitOID := s.MakeCommit(newTree, parents, message)
	repo.Refs[ref] = commitOID
	repo.Rev++
	repo.repoJSONBuf = nil
	return &ContentsResult{CommitOID: commitOID, BlobOID: blobOID, Created: isNewFile || createdBranch}, 0, ""
}

// DeleteContents deletes a file from a branch.
func (s *Store) DeleteContents(repo *Repo, branchName, path, message, expectedSHA string) (*ContentsResult, int, string) {
	ref := "refs/heads/" + branchName
	tip, ok := repo.Refs[ref]
	if !ok {
		return nil, 404, "branch not found"
	}
	obj := s.Objects[tip]
	if obj == nil {
		return nil, 404, "branch not found"
	}
	tree := parseCommit(obj.Data).Tree
	current := s.TreeBlobAt(tree, path)
	if current == "" {
		return nil, 404, "file not found"
	}
	if expectedSHA != "" && current != expectedSHA {
		return nil, 409, "sha does not match the current file"
	}
	newTree := s.EditTree(tree, strings.Split(path, "/"), "", "100644")
	commitOID := s.MakeCommit(newTree, []string{tip}, message)
	repo.Refs[ref] = commitOID
	repo.Rev++
	repo.repoJSONBuf = nil
	return &ContentsResult{CommitOID: commitOID}, 0, ""
}

// ListCommits lists commits reachable from a ref tip, newest first
// (first-parent walk).
func (s *Store) ListCommits(tip string, limit int) []string {
	var out []string
	seen := map[string]bool{}
	queue := []string{tip}
	for len(queue) > 0 && len(out) < limit {
		oid := queue[0]
		queue = queue[1:]
		if seen[oid] {
			continue
		}
		seen[oid] = true
		obj := s.Objects[oid]
		if obj == nil || obj.Type != ObjCommit {
			continue
		}
		out = append(out, oid)
		c := parseCommit(obj.Data)
		if len(c.Parents) > 0 {
			queue = append(queue, c.Parents[0])
		}
	}
	return out
}

// ReachableSet returns the reachable set of a ref tip (for pack exclusion).
func (s *Store) ReachableSet(tip string) map[string]bool {
	set, _ := collectReachable([]string{tip}, s.Lookup)
	return set
}

// FastForwardOK reports whether newOID fast-forwards oldOID (old ZERO =
// create, new ZERO = delete).
func FastForwardOK(s *Store, oldOID, newOID string) bool {
	if oldOID == ZeroOID {
		return true
	}
	if newOID == ZeroOID {
		return true
	}
	// Walk the new tip's parents from the index (parsed once at store time),
	// so a long chain costs map lookups instead of a re-parse per commit.
	seen := map[string]bool{}
	queue := []string{newOID}
	for len(queue) > 0 {
		cur := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if cur == oldOID {
			return true
		}
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if parents, ok := s.CommitParents[cur]; ok {
			queue = append(queue, parents...)
		} else if obj := s.Objects[cur]; obj != nil && obj.Type == ObjCommit {
			queue = append(queue, parseCommit(obj.Data).Parents...)
		}
	}
	return false
}
