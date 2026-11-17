// gqlface.go — a small GraphQL parser and executor for the v4 surface the suite
// exercises: viewer, repository (+ issues/pullRequests connections with
// cursors), issue/pullRequest by number, node(id), the five mutations, and
// __type introspection. No external dependency; the parser is a hand-rolled
// recursive-descent reader over the query text.
// A direct port of the proven Node implementation.

package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type gqlVar struct{ name string }
type gqlEnum struct{ name string }

// GqlSelection is one field or one inline fragment in a selection set.
type GqlSelection struct {
	Kind          string // "field" or "fragment"
	Alias         string
	Name          string
	Args          map[string]any
	Selections    []*GqlSelection
	TypeCondition string
	Spread        string // named fragment spread, when Kind == "fragment"
}

type GqlOperation struct {
	Type    string // "query" or "mutation"
	Name    string
	VarDefs map[string]any
	Selections []*GqlSelection
}

type gqlParser struct {
	input string
	pos   int
}

func (p *gqlParser) skipWs() {
	for {
		if p.pos >= len(p.input) {
			return
		}
		c := p.input[p.pos]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' {
			p.pos++
		} else if c == '#' {
			for p.pos < len(p.input) && p.input[p.pos] != '\n' {
				p.pos++
			}
		} else {
			return
		}
	}
}

func (p *gqlParser) peek() byte {
	p.skipWs()
	if p.pos >= len(p.input) {
		return 0
	}
	return p.input[p.pos]
}

func (p *gqlParser) consume(expected string) error {
	p.skipWs()
	if !strings.HasPrefix(p.input[p.pos:], expected) {
		return fmt.Errorf("expected %s at %d", expected, p.pos)
	}
	p.pos += len(expected)
	return nil
}

func (p *gqlParser) tryConsume(expected string) bool {
	p.skipWs()
	if !strings.HasPrefix(p.input[p.pos:], expected) {
		return false
	}
	p.pos += len(expected)
	return true
}

func isNameStart(c byte) bool {
	return c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}
func isNameChar(c byte) bool {
	return isNameStart(c) || (c >= '0' && c <= '9')
}

func (p *gqlParser) parseName() (string, error) {
	p.skipWs()
	start := p.pos
	if p.pos < len(p.input) && isNameStart(p.input[p.pos]) {
		p.pos++
		for p.pos < len(p.input) && isNameChar(p.input[p.pos]) {
			p.pos++
		}
		return p.input[start:p.pos], nil
	}
	return "", fmt.Errorf("expected name at %d", p.pos)
}

func (p *gqlParser) parseString() (string, error) {
	p.skipWs()
	if p.pos >= len(p.input) || p.input[p.pos] != '"' {
		return "", fmt.Errorf("expected string at %d", p.pos)
	}
	p.pos++
	var sb strings.Builder
	for p.pos < len(p.input) {
		c := p.input[p.pos]
		if c == '"' {
			p.pos++
			return sb.String(), nil
		}
		if c == '\\' {
			n := byte(0)
			if p.pos+1 < len(p.input) {
				n = p.input[p.pos+1]
			}
			p.pos += 2
			switch n {
			case 'n':
				sb.WriteByte('\n')
			case 't':
				sb.WriteByte('\t')
			case 'r':
				sb.WriteByte('\r')
			case 'u':
				if p.pos+4 <= len(p.input) {
					if v, err := strconv.ParseInt(p.input[p.pos:p.pos+4], 16, 32); err == nil {
						sb.WriteRune(rune(v))
					}
					p.pos += 4
				}
			default:
				sb.WriteByte(n)
			}
			continue
		}
		sb.WriteByte(c)
		p.pos++
	}
	return "", fmt.Errorf("unterminated string")
}

func (p *gqlParser) parseNumber() (float64, error) {
	p.skipWs()
	start := p.pos
	for p.pos < len(p.input) {
		c := p.input[p.pos]
		if c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' || (c >= '0' && c <= '9') {
			p.pos++
		} else {
			break
		}
	}
	if p.pos == start {
		return 0, fmt.Errorf("expected number at %d", p.pos)
	}
	return strconv.ParseFloat(p.input[start:p.pos], 64)
}

func (p *gqlParser) parseValue() (any, error) {
	p.skipWs()
	if p.pos >= len(p.input) {
		return nil, fmt.Errorf("unexpected end of query")
	}
	c := p.input[p.pos]
	switch {
	case c == '"':
		return p.parseString()
	case c == '[':
		p.pos++
		var items []any
		for !p.tryConsume("]") {
			v, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			items = append(items, v)
		}
		return items, nil
	case c == '{':
		p.pos++
		obj := map[string]any{}
		for !p.tryConsume("}") {
			key, err := p.parseName()
			if err != nil {
				return nil, err
			}
			if err := p.consume(":"); err != nil {
				return nil, err
			}
			v, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			obj[key] = v
		}
		return obj, nil
	case c == '$':
		p.pos++
		name, err := p.parseName()
		if err != nil {
			return nil, err
		}
		return gqlVar{name}, nil
	case c == '-' || (c >= '0' && c <= '9'):
		return p.parseNumber()
	default:
		name, err := p.parseName()
		if err != nil {
			return nil, err
		}
		switch name {
		case "true":
			return true, nil
		case "false":
			return false, nil
		case "null":
			return nil, nil
		default:
			return gqlEnum{name}, nil
		}
	}
}

func (p *gqlParser) parseArguments() (map[string]any, error) {
	args := map[string]any{}
	if !p.tryConsume("(") {
		return args, nil
	}
	for !p.tryConsume(")") {
		name, err := p.parseName()
		if err != nil {
			return nil, err
		}
		if err := p.consume(":"); err != nil {
			return nil, err
		}
		v, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		args[name] = v
	}
	return args, nil
}

func (p *gqlParser) skipDirectives() error {
	for p.peek() == '@' {
		p.pos++
		if _, err := p.parseName(); err != nil {
			return err
		}
		if _, err := p.parseArguments(); err != nil {
			return err
		}
	}
	return nil
}

func (p *gqlParser) parseSelectionSet() ([]*GqlSelection, error) {
	if err := p.consume("{"); err != nil {
		return nil, err
	}
	var selections []*GqlSelection
	for !p.tryConsume("}") {
		if p.peek() == 0 {
			return nil, fmt.Errorf("unexpected end of query")
		}
		if strings.HasPrefix(p.input[p.pos:], "...") {
			p.pos += 3
			p.skipWs()
			c := p.peek()
			if c == '{' || isNameStart(c) {
				var typeCondition string
				if strings.HasPrefix(p.input[p.pos:], "on ") {
					p.pos += 3
					name, err := p.parseName()
					if err != nil {
						return nil, err
					}
					typeCondition = name
				}
				if err := p.skipDirectives(); err != nil {
					return nil, err
				}
				sels, err := p.parseSelectionSet()
				if err != nil {
					return nil, err
				}
				selections = append(selections, &GqlSelection{Kind: "fragment", TypeCondition: typeCondition, Selections: sels})
			} else {
				fragName, err := p.parseName()
				if err != nil {
					return nil, err
				}
				if err := p.skipDirectives(); err != nil {
					return nil, err
				}
				selections = append(selections, &GqlSelection{Kind: "fragment", Spread: fragName})
			}
		} else {
			first, err := p.parseName()
			if err != nil {
				return nil, err
			}
			alias, name := first, first
			if p.tryConsume(":") {
				name, err = p.parseName()
				if err != nil {
					return nil, err
				}
			}
			args, err := p.parseArguments()
			if err != nil {
				return nil, err
			}
			if err := p.skipDirectives(); err != nil {
				return nil, err
			}
			var sels []*GqlSelection
			if p.peek() == '{' {
				sels, err = p.parseSelectionSet()
				if err != nil {
					return nil, err
				}
			}
			selections = append(selections, &GqlSelection{Kind: "field", Alias: alias, Name: name, Args: args, Selections: sels})
		}
	}
	return selections, nil
}

func (p *gqlParser) skipType() error {
	p.skipWs()
	if p.tryConsume("[") {
		if err := p.skipType(); err != nil {
			return err
		}
		if err := p.consume("]"); err != nil {
			return err
		}
	} else {
		if _, err := p.parseName(); err != nil {
			return err
		}
	}
	p.tryConsume("!")
	return nil
}

type gqlDocument struct {
	operations []*GqlOperation
	fragments  map[string][]*GqlSelection
}

func (p *gqlParser) parseDocument() (*gqlDocument, error) {
	doc := &gqlDocument{fragments: map[string][]*GqlSelection{}}
	for {
		p.skipWs()
		if p.pos >= len(p.input) {
			break
		}
		if strings.HasPrefix(p.input[p.pos:], "fragment") && (p.pos+8 >= len(p.input) || !isNameChar(p.input[p.pos+8])) {
			p.pos += len("fragment")
			name, err := p.parseName()
			if err != nil {
				return nil, err
			}
			p.skipWs()
			if strings.HasPrefix(p.input[p.pos:], "on ") {
				p.pos += 3
				if _, err := p.parseName(); err != nil {
					return nil, err
				}
			}
			if err := p.skipDirectives(); err != nil {
				return nil, err
			}
			sels, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			doc.fragments[name] = sels
			continue
		}
		typ := "query"
		if strings.HasPrefix(p.input[p.pos:], "query") && (p.pos+5 >= len(p.input) || !isNameChar(p.input[p.pos+5])) {
			p.pos += 5
			typ = "query"
		} else if strings.HasPrefix(p.input[p.pos:], "mutation") && (p.pos+8 >= len(p.input) || !isNameChar(p.input[p.pos+8])) {
			p.pos += 8
			typ = "mutation"
		}
		p.skipWs()
		var name string
		c := p.peek()
		if c != 0 && c != '{' && c != '(' {
			n, err := p.parseName()
			if err != nil {
				return nil, err
			}
			name = n
		}
		varDefs := map[string]any{}
		if p.tryConsume("(") {
			for !p.tryConsume(")") {
				if p.peek() == '$' {
					p.pos++
					varName, err := p.parseName()
					if err != nil {
						return nil, err
					}
					if err := p.consume(":"); err != nil {
						return nil, err
					}
					if err := p.skipType(); err != nil {
						return nil, err
					}
					if p.tryConsume("=") {
						v, err := p.parseValue()
						if err != nil {
							return nil, err
						}
						varDefs[varName] = v
					} else {
						varDefs[varName] = nil
					}
				} else {
					if _, err := p.parseName(); err != nil {
						return nil, err
					}
				}
			}
		}
		if err := p.skipDirectives(); err != nil {
			return nil, err
		}
		sels, err := p.parseSelectionSet()
		if err != nil {
			return nil, err
		}
		doc.operations = append(doc.operations, &GqlOperation{Type: typ, Name: name, VarDefs: varDefs, Selections: sels})
	}
	return doc, nil
}

func parseGraphQL(query string) (*gqlDocument, error) {
	return (&gqlParser{input: query}).parseDocument()
}

// resolveValue resolves $var / enum wrappers against the operation's
// variables and defaults.
func resolveValue(value any, variables, varDefs map[string]any) any {
	switch v := value.(type) {
	case gqlVar:
		if val, ok := variables[v.name]; ok && val != nil {
			return val
		}
		if def, ok := varDefs[v.name]; ok {
			return resolveValue(def, variables, varDefs)
		}
		return nil
	case gqlEnum:
		return v.name
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = resolveValue(item, variables, varDefs)
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for k, item := range v {
			out[k] = resolveValue(item, variables, varDefs)
		}
		return out
	default:
		return value
	}
}

// expandFragments inlines named-fragment spreads using the document's
// fragment definitions.
func expandFragments(selections []*GqlSelection, fragments map[string][]*GqlSelection) []*GqlSelection {
	var out []*GqlSelection
	for _, sel := range selections {
		if sel.Kind == "fragment" {
			if sel.Spread != "" {
				if def, ok := fragments[sel.Spread]; ok {
					out = append(out, expandFragments(def, fragments)...)
					continue
				}
			}
			cp := *sel
			cp.Selections = expandFragments(sel.Selections, fragments)
			out = append(out, &cp)
		} else {
			cp := *sel
			cp.Selections = expandFragments(sel.Selections, fragments)
			out = append(out, &cp)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type gqlNode map[string]any

type unknownFieldError struct{ msg string }

func (e *unknownFieldError) Error() string { return e.msg }

var gqlSchema = map[string]struct {
	kind   string
	fields []string
	values []string
}{
	"Issue": {kind: "OBJECT", fields: []string{"id", "number", "title", "state", "body", "bodyText", "createdAt", "updatedAt", "url", "author", "comments", "labels"}},
	"PullRequest": {kind: "OBJECT", fields: []string{"id", "number", "title", "state", "headRefName", "baseRefName", "mergeable", "merged", "body", "files", "createdAt", "updatedAt", "url", "author", "mergedAt", "mergeCommit"}},
	"Repository": {kind: "OBJECT", fields: []string{"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "createdAt", "updatedAt", "url", "isPrivate"}},
	"SearchType": {kind: "ENUM", values: []string{"ISSUE", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "CODE"}},
	"User":       {kind: "OBJECT", fields: []string{"id", "login", "name"}},
}

func cursorFor(n int) string { return b64url("cursor:" + itoa(n)) }

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func cursorNumber(cursor any) (int, bool) {
	s, ok := cursor.(string)
	if !ok {
		return 0, false
	}
	raw, err := base64URLDecode(s)
	if err != nil {
		return 0, false
	}
	text := string(raw)
	if len(text) < 8 || text[:7] != "cursor:" {
		return 0, false
	}
	n, err := strconv.Atoi(text[7:])
	if err != nil {
		return 0, false
	}
	return n, true
}

type connArgs struct {
	first   int
	hasFirst bool
	after   string
	states  []string
	orderBy map[string]any
}

func parseConnArgs(args map[string]any) connArgs {
	var ca connArgs
	if v, ok := args["first"].(float64); ok {
		ca.first = int(v)
		ca.hasFirst = true
	}
	if v, ok := args["after"].(string); ok {
		ca.after = v
	}
	if arr, ok := args["states"].([]any); ok {
		for _, x := range arr {
			if s, ok := x.(string); ok {
				ca.states = append(ca.states, s)
			}
		}
	}
	if m, ok := args["orderBy"].(map[string]any); ok {
		ca.orderBy = m
	}
	return ca
}

// connectionSlice applies states/orderBy/after/first to a numbered list.
func connectionSlice[T any](items []T, number func(T) int, state func(T) string, args connArgs) (slice []T, hasNext bool, endCursor string) {
	filtered := make([]T, 0, len(items))
	if len(args.states) > 0 {
		wanted := map[string]bool{}
		for _, s := range args.states {
			switch s {
			case "OPEN":
				wanted["open"] = true
			case "CLOSED":
				wanted["closed"] = true
			default:
				wanted[strings.ToLower(s)] = true
			}
		}
		for _, it := range items {
			if wanted[state(it)] {
				filtered = append(filtered, it)
			}
		}
	} else {
		filtered = append(filtered, items...)
	}
	direction := "desc"
	if args.orderBy != nil {
		if d, ok := args.orderBy["direction"].(string); ok && d == "ASC" {
			direction = "asc"
		}
	}
	sort.Slice(filtered, func(a, b int) bool {
		if direction == "asc" {
			return number(filtered[a]) < number(filtered[b])
		}
		return number(filtered[a]) > number(filtered[b])
	})
	if after, ok := cursorNumber(args.after); ok {
		var kept []T
		for _, it := range filtered {
			if direction == "asc" {
				if number(it) > after {
					kept = append(kept, it)
				}
			} else if number(it) < after {
				kept = append(kept, it)
			}
		}
		filtered = kept
	}
	first := len(filtered)
	if args.hasFirst && args.first >= 0 && args.first < first {
		first = args.first
	}
	slice = filtered[:first]
	hasNext = len(filtered) > len(slice)
	if len(slice) > 0 {
		endCursor = cursorFor(number(slice[len(slice)-1]))
	}
	return slice, hasNext, endCursor
}

func pageInfoNode(hasNext bool, endCursor string) gqlNode {
	return gqlNode{"__type": "PageInfo", "hasNextPage": hasNext, "endCursor": endCursor, "hasPreviousPage": false, "startCursor": endCursor}
}

func issueNode(store *Store, repo *Repo, issue *Issue) gqlNode {
	return gqlNode{"__type": "Issue", "repo": repo, "issue": issue, "store": store}
}
func pullNode(store *Store, repo *Repo, pr *Pull) gqlNode {
	return gqlNode{"__type": "PullRequest", "repo": repo, "pr": pr, "store": store}
}
func repoNode(store *Store, repo *Repo) gqlNode {
	return gqlNode{"__type": "Repository", "repo": repo, "store": store}
}

func prState(pr *Pull) string {
	if pr.Merged {
		return "MERGED"
	}
	if pr.State == "open" {
		return "OPEN"
	}
	return "CLOSED"
}

func resolveField(node gqlNode, name string, args map[string]any, store *Store) (any, error) {
	typ, _ := node["__type"].(string)
	bad := func() (any, error) {
		return nil, &unknownFieldError{msg: fmt.Sprintf("Cannot query field %q on type %q.", name, typ)}
	}
	switch typ {
	case "Query":
		switch name {
		case "viewer":
			return gqlNode{"__type": "User", "login": store.Viewer, "store": store}, nil
		case "repository":
			owner, _ := args["owner"].(string)
			repoName, _ := args["name"].(string)
			repo := store.FindRepo(owner, repoName)
			if repo == nil {
				return nil, nil
			}
			return repoNode(store, repo), nil
		case "node":
			id, _ := args["id"].(string)
			decoded := decodeGlobalID(id)
			if decoded == nil {
				return nil, nil
			}
			repo := store.FindRepo(decoded.Owner, decoded.Repo)
			if repo == nil {
				return nil, nil
			}
			switch decoded.Kind {
			case "Repository":
				return repoNode(store, repo), nil
			case "Issue":
				for _, i := range repo.Issues {
					if i.Number == decoded.Number {
						return issueNode(store, repo, i), nil
					}
				}
			case "PullRequest":
				for _, p := range repo.Pulls {
					if p.Number == decoded.Number {
						return pullNode(store, repo, p), nil
					}
				}
			}
			return nil, nil
		case "__type":
			typeName, _ := args["name"].(string)
			entry, ok := gqlSchema[typeName]
			if !ok {
				return nil, nil
			}
			return gqlNode{"__type": "__Type", "name": typeName, "kind": entry.kind, "fields": entry.fields, "enumValues": entry.values}, nil
		case "__schema":
			return nil, nil
		case "createIssue":
			return createIssueMutation(args, store)
		case "closeIssue":
			return closeIssueMutation(args, store)
		case "createPullRequest":
			return createPullRequestMutation(args, store)
		case "mergePullRequest":
			return mergePullRequestMutation(args, store)
		case "addComment":
			return addCommentMutation(args, store)
		}
		return bad()
	case "User":
		switch name {
		case "login", "name":
			login, _ := node["login"].(string)
			return login, nil
		case "id":
			return "1", nil
		}
		return bad()
	case "Repository":
		repo := node["repo"].(*Repo)
		switch name {
		case "id":
			return repoGlobalID(store.ownerOf(repo), repo.Name), nil
		case "databaseId":
			return repo.ID, nil
		case "name":
			return repo.Name, nil
		case "nameWithOwner":
			return store.ownerOf(repo) + "/" + repo.Name, nil
		case "owner":
			return gqlNode{"__type": "User", "login": store.ownerOf(repo), "store": store}, nil
		case "defaultBranchRef":
			if _, ok := repo.Refs["refs/heads/"+repo.DefaultBranch]; ok {
				return gqlNode{"__type": "Ref", "name": repo.DefaultBranch}, nil
			}
			return nil, nil
		case "viewerPermission":
			return "ADMIN", nil
		case "hasIssuesEnabled":
			return true, nil
		case "description":
			return repo.Description, nil
		case "createdAt":
			return repo.CreatedAt, nil
		case "updatedAt":
			return repo.UpdatedAt, nil
		case "url":
			return "https://example.invalid/" + store.ownerOf(repo) + "/" + repo.Name, nil
		case "isPrivate":
			return repo.Private, nil
		case "issue":
			n := argInt(args, "number")
			for _, i := range repo.Issues {
				if i.Number == n {
					return issueNode(store, repo, i), nil
				}
			}
			return nil, nil
		case "issues":
			slice, hasNext, endCursor := connectionSlice(repo.Issues,
				func(i *Issue) int { return i.Number },
				func(i *Issue) string { return i.State },
				parseConnArgs(args))
			nodes := make([]any, 0, len(slice))
			edges := make([]any, 0, len(slice))
			for _, i := range slice {
				n := issueNode(store, repo, i)
				nodes = append(nodes, n)
				edges = append(edges, gqlNode{"__type": "IssueEdge", "node": n, "cursor": cursorFor(i.Number)})
			}
			return gqlNode{"__type": "IssueConnection", "nodes": nodes, "edges": edges,
				"pageInfo": pageInfoNode(hasNext, endCursor), "totalCount": len(repo.Issues)}, nil
		case "pullRequest":
			n := argInt(args, "number")
			for _, p := range repo.Pulls {
				if p.Number == n {
					return pullNode(store, repo, p), nil
				}
			}
			return nil, nil
		case "pullRequests":
			slice, hasNext, endCursor := connectionSlice(repo.Pulls,
				func(p *Pull) int { return p.Number },
				func(p *Pull) string { return p.State },
				parseConnArgs(args))
			nodes := make([]any, 0, len(slice))
			edges := make([]any, 0, len(slice))
			for _, p := range slice {
				n := pullNode(store, repo, p)
				nodes = append(nodes, n)
				edges = append(edges, gqlNode{"__type": "PullRequestEdge", "node": n, "cursor": cursorFor(p.Number)})
			}
			return gqlNode{"__type": "PullRequestConnection", "nodes": nodes, "edges": edges,
				"pageInfo": pageInfoNode(hasNext, endCursor), "totalCount": len(repo.Pulls)}, nil
		}
		return bad()
	case "Issue":
		repo := node["repo"].(*Repo)
		issue := node["issue"].(*Issue)
		switch name {
		case "id":
			return issueGlobalID(store.ownerOf(repo), repo.Name, issue.Number), nil
		case "number":
			return issue.Number, nil
		case "title":
			return issue.Title, nil
		case "state":
			if issue.State == "open" {
				return "OPEN", nil
			}
			return "CLOSED", nil
		case "body", "bodyText":
			return issue.Body, nil
		case "createdAt":
			return issue.CreatedAt, nil
		case "updatedAt":
			return issue.UpdatedAt, nil
		case "url":
			return "https://example.invalid/" + store.ownerOf(repo) + "/" + repo.Name + "/issues/" + itoa(issue.Number), nil
		case "author":
			return gqlNode{"__type": "User", "login": store.ownerOf(repo), "store": store}, nil
		case "labels":
			nodes := make([]any, 0, len(issue.Labels))
			for _, l := range issue.Labels {
				nodes = append(nodes, gqlNode{"__type": "Label", "name": l.Name, "color": l.Color})
			}
			return gqlNode{"__type": "LabelConnection", "nodes": nodes}, nil
		case "comments":
			comments := repo.Comments[issue.Number]
			first := len(comments)
			if v, ok := args["first"].(float64); ok && int(v) < first {
				first = int(v)
			}
			slice := comments[:first]
			nodes := make([]any, 0, len(slice))
			edges := make([]any, 0, len(slice))
			for _, cm := range slice {
				n := gqlNode{"__type": "IssueComment",
					"id":        commentGlobalID(store.ownerOf(repo), repo.Name, issue.Number, cm.ID),
					"body":      cm.Body,
					"createdAt": cm.CreatedAt, "updatedAt": cm.UpdatedAt,
					"author": gqlNode{"__type": "User", "login": store.ownerOf(repo), "store": store}}
				nodes = append(nodes, n)
				edges = append(edges, gqlNode{"__type": "IssueCommentEdge", "node": n, "cursor": cursorFor(cm.ID)})
			}
			var endCursor string
			if len(slice) > 0 {
				endCursor = cursorFor(slice[len(slice)-1].ID)
			}
			return gqlNode{"__type": "IssueCommentConnection", "nodes": nodes, "edges": edges,
				"pageInfo": pageInfoNode(len(comments) > len(slice), endCursor), "totalCount": len(comments)}, nil
		}
		return bad()
	case "PullRequest":
		repo := node["repo"].(*Repo)
		pr := node["pr"].(*Pull)
		switch name {
		case "id":
			return pullGlobalID(store.ownerOf(repo), repo.Name, pr.Number), nil
		case "number":
			return pr.Number, nil
		case "title":
			return pr.Title, nil
		case "state":
			return prState(pr), nil
		case "headRefName":
			return pr.HeadRef, nil
		case "baseRefName":
			return pr.BaseRef, nil
		case "mergeable":
			if pr.Merged || !PrHasConflict(store, repo, pr) {
				return "MERGEABLE", nil
			}
			return "CONFLICTING", nil
		case "merged":
			return pr.Merged, nil
		case "body":
			return pr.Body, nil
		case "createdAt":
			return pr.CreatedAt, nil
		case "updatedAt":
			return pr.UpdatedAt, nil
		case "url":
			return "https://example.invalid/" + store.ownerOf(repo) + "/" + repo.Name + "/pull/" + itoa(pr.Number), nil
		case "author":
			return gqlNode{"__type": "User", "login": store.ownerOf(repo), "store": store}, nil
		case "mergedAt":
			if pr.MergedAt == "" {
				return nil, nil
			}
			return pr.MergedAt, nil
		case "mergeCommit":
			if pr.MergeCommitSHA == "" {
				return nil, nil
			}
			return gqlNode{"__type": "Commit", "oid": pr.MergeCommitSHA}, nil
		case "files":
			first := len(pr.Files)
			if v, ok := args["first"].(float64); ok && int(v) < first {
				first = int(v)
			}
			slice := pr.Files[:first]
			nodes := make([]any, 0, len(slice))
			for _, f := range slice {
				nodes = append(nodes, gqlNode{"__type": "File", "path": f.Filename,
					"additions": f.Additions, "deletions": f.Deletions, "changeType": strings.ToUpper(f.Status)})
			}
			return gqlNode{"__type": "FileConnection", "nodes": nodes,
				"pageInfo": pageInfoNode(len(pr.Files) > len(slice), ""), "totalCount": len(pr.Files)}, nil
		}
		return bad()
	case "IssueConnection", "PullRequestConnection", "IssueCommentConnection", "FileConnection", "LabelConnection":
		switch name {
		case "nodes":
			return node["nodes"], nil
		case "edges":
			if e, ok := node["edges"]; ok {
				return e, nil
			}
			return nil, nil
		case "pageInfo":
			return node["pageInfo"], nil
		case "totalCount":
			return node["totalCount"], nil
		}
		return bad()
	case "IssueEdge", "PullRequestEdge", "IssueCommentEdge", "CommentEdge":
		switch name {
		case "node":
			return node["node"], nil
		case "cursor":
			return node["cursor"], nil
		}
		return bad()
	case "PageInfo":
		switch name {
		case "hasNextPage":
			return node["hasNextPage"], nil
		case "endCursor":
			return node["endCursor"], nil
		case "hasPreviousPage":
			return node["hasPreviousPage"], nil
		case "startCursor":
			return node["startCursor"], nil
		}
		return bad()
	case "IssueComment":
		switch name {
		case "id":
			return node["id"], nil
		case "body":
			return node["body"], nil
		case "createdAt":
			return node["createdAt"], nil
		case "updatedAt":
			return node["updatedAt"], nil
		case "author":
			return node["author"], nil
		}
		return bad()
	case "Label":
		switch name {
		case "name":
			return node["name"], nil
		case "color":
			return node["color"], nil
		case "id":
			return node["id"], nil
		}
		return bad()
	case "File":
		switch name {
		case "path":
			return node["path"], nil
		case "additions":
			return node["additions"], nil
		case "deletions":
			return node["deletions"], nil
		case "changeType":
			return node["changeType"], nil
		}
		return bad()
	case "Ref":
		if name == "name" {
			return node["name"], nil
		}
		return bad()
	case "Commit":
		if name == "oid" {
			return node["oid"], nil
		}
		return bad()
	case "__Type":
		switch name {
		case "name":
			return node["name"], nil
		case "kind":
			return node["kind"], nil
		case "fields":
			fields, _ := node["fields"].([]string)
			if fields == nil {
				return nil, nil
			}
			out := make([]any, 0, len(fields))
			for _, f := range fields {
				out = append(out, gqlNode{"__type": "Field", "name": f})
			}
			return out, nil
		case "enumValues":
			values, _ := node["enumValues"].([]string)
			if values == nil {
				return nil, nil
			}
			out := make([]any, 0, len(values))
			for _, v := range values {
				out = append(out, gqlNode{"__type": "EnumValue", "name": v})
			}
			return out, nil
		}
		return bad()
	case "Field", "EnumValue":
		if name == "name" {
			return node["name"], nil
		}
		return bad()
	case "CreateIssuePayload", "CloseIssuePayload":
		if name == "issue" {
			return node["issue"], nil
		}
		return bad()
	case "CreatePullRequestPayload", "MergePullRequestPayload":
		if name == "pullRequest" {
			return node["pullRequest"], nil
		}
		return bad()
	case "AddCommentPayload":
		if name == "commentEdge" {
			return node["commentEdge"], nil
		}
		return bad()
	}
	return bad()
}

func argInt(args map[string]any, key string) int {
	if v, ok := args[key].(float64); ok {
		return int(v)
	}
	return 0
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

func inputOf(args map[string]any) map[string]any {
	if m, ok := args["input"].(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func createIssueMutation(args map[string]any, store *Store) (any, error) {
	input := inputOf(args)
	decoded := decodeGlobalID(argStr(input, "repositoryId"))
	if decoded == nil {
		return nil, fmt.Errorf("repository not found")
	}
	repo := store.FindRepo(decoded.Owner, decoded.Repo)
	if repo == nil {
		return nil, fmt.Errorf("repository not found")
	}
	issue, errMsg := store.CreateIssue(repo, argStr(input, "title"), argStr(input, "body"), nil)
	if issue == nil {
		return nil, fmt.Errorf("%s", errMsg)
	}
	return gqlNode{"__type": "CreateIssuePayload", "issue": issueNode(store, repo, issue)}, nil
}

func closeIssueMutation(args map[string]any, store *Store) (any, error) {
	input := inputOf(args)
	decoded := decodeGlobalID(argStr(input, "issueId"))
	if decoded == nil {
		return nil, fmt.Errorf("issue not found")
	}
	repo := store.FindRepo(decoded.Owner, decoded.Repo)
	var issue *Issue
	if repo != nil {
		for _, i := range repo.Issues {
			if i.Number == decoded.Number {
				issue = i
				break
			}
		}
	}
	if repo == nil || issue == nil {
		return nil, fmt.Errorf("issue not found")
	}
	issue.State = "closed"
	issue.UpdatedAt = store.Clock.ISO()
	issue.jsonBuf = nil
	return gqlNode{"__type": "CloseIssuePayload", "issue": issueNode(store, repo, issue)}, nil
}

func createPullRequestMutation(args map[string]any, store *Store) (any, error) {
	input := inputOf(args)
	decoded := decodeGlobalID(argStr(input, "repositoryId"))
	if decoded == nil {
		return nil, fmt.Errorf("repository not found")
	}
	repo := store.FindRepo(decoded.Owner, decoded.Repo)
	if repo == nil {
		return nil, fmt.Errorf("repository not found")
	}
	pr, errMsg := store.CreatePull(repo, argStr(input, "title"), argStr(input, "body"),
		argStr(input, "headRefName"), argStr(input, "baseRefName"))
	if pr == nil {
		return nil, fmt.Errorf("%s", errMsg)
	}
	return gqlNode{"__type": "CreatePullRequestPayload", "pullRequest": pullNode(store, repo, pr)}, nil
}

func mergePullRequestMutation(args map[string]any, store *Store) (any, error) {
	input := inputOf(args)
	decoded := decodeGlobalID(argStr(input, "pullRequestId"))
	if decoded == nil {
		return nil, fmt.Errorf("pull request not found")
	}
	repo := store.FindRepo(decoded.Owner, decoded.Repo)
	var pr *Pull
	if repo != nil {
		for _, p := range repo.Pulls {
			if p.Number == decoded.Number {
				pr = p
				break
			}
		}
	}
	if repo == nil || pr == nil {
		return nil, fmt.Errorf("pull request not found")
	}
	if !pr.Merged && !PrHasConflict(store, repo, pr) {
		store.MergePull(repo, pr)
	}
	return gqlNode{"__type": "MergePullRequestPayload", "pullRequest": pullNode(store, repo, pr)}, nil
}

func addCommentMutation(args map[string]any, store *Store) (any, error) {
	input := inputOf(args)
	decoded := decodeGlobalID(argStr(input, "subjectId"))
	if decoded == nil {
		return nil, fmt.Errorf("issue not found")
	}
	repo := store.FindRepo(decoded.Owner, decoded.Repo)
	var issue *Issue
	if repo != nil {
		for _, i := range repo.Issues {
			if i.Number == decoded.Number {
				issue = i
				break
			}
		}
	}
	if repo == nil || issue == nil {
		return nil, fmt.Errorf("issue not found")
	}
	now := store.Clock.ISO()
	comment := &Comment{ID: repo.NextCommentID, Body: argStr(input, "body"), CreatedAt: now, UpdatedAt: now}
	repo.NextCommentID++
	repo.Comments[issue.Number] = append(repo.Comments[issue.Number], comment)
	issue.jsonBuf = nil
	node := gqlNode{"__type": "IssueComment",
		"id":        commentGlobalID(store.ownerOf(repo), repo.Name, issue.Number, comment.ID),
		"body":      comment.Body,
		"createdAt": comment.CreatedAt, "updatedAt": comment.UpdatedAt,
		"author":    gqlNode{"__type": "User", "login": store.ownerOf(repo), "store": store}}
	return gqlNode{"__type": "AddCommentPayload",
		"commentEdge": gqlNode{"__type": "CommentEdge", "node": node, "cursor": cursorFor(comment.ID)}}, nil
}

func argStr(m map[string]any, key string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

// ---------------------------------------------------------------------------
// selection resolution
// ---------------------------------------------------------------------------

func resolveSelections(selections []*GqlSelection, node gqlNode, store *Store, variables, varDefs map[string]any) (map[string]any, error) {
	out := map[string]any{}
	for _, sel := range selections {
		if sel.Kind == "fragment" {
			if sel.TypeCondition != "" && sel.TypeCondition != node["__type"] {
				continue
			}
			sub, err := resolveSelections(sel.Selections, node, store, variables, varDefs)
			if err != nil {
				return nil, err
			}
			for k, v := range sub {
				out[k] = v
			}
			continue
		}
		if sel.Name == "__typename" {
			out[sel.Alias] = node["__type"]
			continue
		}
		args := map[string]any{}
		for k, v := range sel.Args {
			args[k] = resolveValue(v, variables, varDefs)
		}
		value, err := resolveField(node, sel.Name, args, store)
		if err != nil {
			return nil, err
		}
		if value == nil {
			out[sel.Alias] = nil
			continue
		}
		if len(sel.Selections) == 0 {
			out[sel.Alias] = value
			continue
		}
		if arr, ok := value.([]any); ok {
			mapped := make([]any, 0, len(arr))
			for _, item := range arr {
				if n, ok := item.(gqlNode); ok {
					sub, err := resolveSelections(sel.Selections, n, store, variables, varDefs)
					if err != nil {
						return nil, err
					}
					mapped = append(mapped, sub)
				} else {
					mapped = append(mapped, item)
				}
			}
			out[sel.Alias] = mapped
			continue
		}
		if n, ok := value.(gqlNode); ok {
			sub, err := resolveSelections(sel.Selections, n, store, variables, varDefs)
			if err != nil {
				return nil, err
			}
			out[sel.Alias] = sub
			continue
		}
		out[sel.Alias] = value
	}
	return out, nil
}

func executeOne(body any, store *Store) map[string]any {
	b, ok := body.(map[string]any)
	if !ok {
		return map[string]any{"data": nil, "errors": []any{map[string]any{"message": "query must be an object"}}}
	}
	query, ok := b["query"].(string)
	if !ok {
		return map[string]any{"data": nil, "errors": []any{map[string]any{"message": "query must be a string"}}}
	}
	variables := map[string]any{}
	if v, ok := b["variables"].(map[string]any); ok {
		variables = v
	}
	doc, err := parseGraphQL(query)
	if err != nil {
		return map[string]any{"data": nil, "errors": []any{map[string]any{"message": err.Error()}}}
	}
	var operation *GqlOperation
	if name, ok := b["operationName"].(string); ok && name != "" {
		for _, o := range doc.operations {
			if o.Name == name {
				operation = o
				break
			}
		}
	}
	if operation == nil && len(doc.operations) > 0 {
		operation = doc.operations[0]
	}
	if operation == nil {
		return map[string]any{"data": nil, "errors": []any{map[string]any{"message": "no operation in query"}}}
	}
	selections := expandFragments(operation.Selections, doc.fragments)
	data, err := resolveSelections(selections, gqlNode{"__type": "Query"}, store, variables, operation.VarDefs)
	if err != nil {
		return map[string]any{"data": nil, "errors": []any{map[string]any{"message": err.Error()}}}
	}
	return map[string]any{"data": data}
}

// handleGraphQL serves POST /api/graphql
func handleGraphQL(c *Ctx) {
	if !hasAuth(c) {
		sendError(c, 401, "requires authentication")
		return
	}
	v, ok := readJSON(c)
	if !ok {
		sendError(c, 400, "malformed JSON")
		return
	}
	if arr, isArr := v.([]any); isArr {
		results := make([]any, 0, len(arr))
		for _, item := range arr {
			results = append(results, executeOne(item, c.Store))
		}
		sendJSON(c, 200, results, nil)
		return
	}
	sendJSON(c, 200, executeOne(v, c.Store), nil)
}
