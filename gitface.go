// gitface.go — git smart HTTP: info/refs (v2 + v0), ls-refs, fetch (v2 + v0)
// and receive-pack (v0). All packs are plain objects; the suite's client only
// ever sends plain packs, and plain packs are all we ever send.
// A direct port of the proven Node implementation.

package main

import (
	"fmt"
	"sort"
	"strings"
)

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

var v2Caps = []string{"version 2", "agent=forge/1.0", "ls-refs=unborn", "fetch=shallow wait-for-done", "object-format=sha1"}

const v0UpCaps = "side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main"
const v0RecvCaps = "report-status side-band-64k delete-refs ofs-delta thin-pack symref=HEAD:refs/heads/main"

func sortedRefNames(repo *Repo) []string {
	names := make([]string, 0, len(repo.Refs))
	for n := range repo.Refs {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func refLinesV0(store *Store, repo *Repo, caps string) []string {
	var lines []string
	names := sortedRefNames(repo)
	headTip := repo.Refs["refs/heads/"+repo.DefaultBranch]
	if len(names) == 0 {
		lines = append(lines, ZeroOID+" capabilities^{}\x00"+caps+"\n")
		return lines
	}
	lines = append(lines, headTip+" HEAD\x00"+caps+"\n")
	for _, name := range names {
		lines = append(lines, repo.Refs[name]+" "+name+"\n")
		if strings.HasPrefix(name, "refs/tags/") {
			if obj := store.Objects[repo.Refs[name]]; obj != nil && obj.Type == ObjTag {
				target := parseTag(obj.Data).Object
				lines = append(lines, target+" "+name+"^{}\n")
			}
		}
	}
	return lines
}

func buildV2Advertisement() []byte {
	var items [][]byte
	items = append(items, pktLineString("# service=git-upload-pack\n"))
	items = append(items, pktFlush)
	for _, cap := range v2Caps {
		items = append(items, pktLineString(cap+"\n"))
	}
	items = append(items, pktFlush)
	return pktLines(items)
}

func buildV0Advertisement(store *Store, repo *Repo, service string) []byte {
	caps := v0UpCaps
	svc := "git-upload-pack"
	if service == "receive" {
		caps = v0RecvCaps
		svc = "git-receive-pack"
	}
	var items [][]byte
	items = append(items, pktLineString("# service="+svc+"\n"))
	items = append(items, pktFlush)
	for _, line := range refLinesV0(store, repo, caps) {
		items = append(items, pktLineString(line))
	}
	items = append(items, pktFlush)
	return pktLines(items)
}

func getAdvertisement(store *Store, repo *Repo, service string, v2 bool) []byte {
	if service == "upload" && v2 {
		if repo.advV2 == nil || repo.advV2Rev != repo.Rev {
			repo.advV2 = buildV2Advertisement()
			repo.advV2Rev = repo.Rev
		}
		return repo.advV2
	}
	if service == "upload" {
		if repo.advV0Up == nil || repo.advV0UpRev != repo.Rev {
			repo.advV0Up = buildV0Advertisement(store, repo, "upload")
			repo.advV0UpRev = repo.Rev
		}
		return repo.advV0Up
	}
	if repo.advV0Recv == nil || repo.advV0RecvRev != repo.Rev {
		repo.advV0Recv = buildV0Advertisement(store, repo, "receive")
		repo.advV0RecvRev = repo.Rev
	}
	return repo.advV0Recv
}

// ---------------------------------------------------------------------------
// ls-refs
// ---------------------------------------------------------------------------

type lsRefsArgs struct {
	peel      bool
	symrefs   bool
	unborn    bool
	refPrefix string
	hasPrefix bool
}

func parseLsRefsBody(body []byte) lsRefsArgs {
	args := lsRefsArgs{}
	packets, _ := decodePktLines(body)
	for _, p := range packets {
		if p.Kind != PktData {
			continue
		}
		line := strings.TrimSpace(string(p.Payload))
		switch {
		case line == "peel":
			args.peel = true
		case line == "symrefs":
			args.symrefs = true
		case line == "unborn":
			args.unborn = true
		case strings.HasPrefix(line, "ref-prefix "):
			args.refPrefix = line[len("ref-prefix "):]
			args.hasPrefix = true
		}
	}
	return args
}

func buildLsRefs(store *Store, repo *Repo, args lsRefsArgs) []byte {
	key := fmt.Sprintf("%v%v%v|%s", args.peel, args.symrefs, args.unborn, args.refPrefix)
	if repo.lsRefsRev == repo.Rev {
		if cached, ok := repo.lsRefsCache[key]; ok {
			return cached
		}
	} else {
		repo.lsRefsCache = map[string][]byte{}
		repo.lsRefsRev = repo.Rev
	}
	var lines []string
	names := sortedRefNames(repo)
	headTip := repo.Refs["refs/heads/"+repo.DefaultBranch]
	headWanted := !args.hasPrefix || strings.HasPrefix("HEAD", args.refPrefix)
	if len(names) == 0 {
		if args.unborn && headWanted {
			lines = append(lines, "unborn HEAD symref-target:refs/heads/"+repo.DefaultBranch+"\n")
		}
	} else {
		if headWanted && headTip != "" {
			if args.symrefs {
				lines = append(lines, headTip+" HEAD symref-target:refs/heads/"+repo.DefaultBranch+"\n")
			} else {
				lines = append(lines, headTip+" HEAD\n")
			}
		}
		for _, name := range names {
			if args.hasPrefix && !strings.HasPrefix(name, args.refPrefix) {
				continue
			}
			oid := repo.Refs[name]
			line := oid + " " + name
			if args.peel && strings.HasPrefix(name, "refs/tags/") {
				if obj := store.Objects[oid]; obj != nil && obj.Type == ObjTag {
					line += " peeled:" + parseTag(obj.Data).Object
				}
			}
			lines = append(lines, line+"\n")
		}
	}
	var items [][]byte
	for _, l := range lines {
		items = append(items, pktLineString(l))
	}
	items = append(items, pktFlush)
	buf := pktLines(items)
	repo.lsRefsCache[key] = buf
	return buf
}

// ---------------------------------------------------------------------------
// repo resolution
// ---------------------------------------------------------------------------

func resolveGitRepo(c *Ctx) *Repo {
	if len(c.Params) < 2 {
		return nil
	}
	owner := decodeSegment(c.Params[0])
	name := decodeSegment(strings.TrimSuffix(c.Params[1], ".git"))
	if owner == "" || name == "" {
		return nil
	}
	repo := c.Store.FindRepo(owner, name)
	if repo != nil {
		c.Store.LearnViewer(owner)
	}
	return repo
}

// handleInfoRefs serves GET /{owner}/{repo}.git/info/refs?service=...
func handleInfoRefs(c *Ctx) {
	service := c.R.URL.Query().Get("service")
	if service != "git-upload-pack" && service != "git-receive-pack" {
		sendError(c, 400, "unknown service")
		return
	}
	repo := resolveGitRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	v2 := strings.Contains(header(c, "Git-Protocol"), "version=2")
	svc := "upload"
	if service == "git-receive-pack" {
		svc = "receive"
	}
	adv := getAdvertisement(c.Store, repo, svc, v2)
	contentType := "application/x-git-upload-pack-advertisement"
	if service == "git-receive-pack" {
		contentType = "application/x-git-receive-pack-advertisement"
	}
	sendRaw(c, 200, contentType, adv)
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

type fetchRequest struct {
	wants    []string
	haves    []string
	shallows []string
	deepen   int // -1 means no deepen
}

func parseFetchV2(body []byte) fetchRequest {
	req := fetchRequest{deepen: -1}
	packets, _ := decodePktLines(body)
	for _, p := range packets {
		if p.Kind != PktData {
			continue
		}
		line := strings.TrimSpace(string(p.Payload))
		switch {
		case strings.HasPrefix(line, "want "):
			req.wants = append(req.wants, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "have "):
			req.haves = append(req.haves, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "shallow "):
			req.shallows = append(req.shallows, strings.TrimSpace(line[8:]))
		case strings.HasPrefix(line, "deepen "):
			var n int
			fmt.Sscanf(line[7:], "%d", &n)
			req.deepen = n
		}
	}
	return req
}

func parseFetchV0(body []byte) fetchRequest {
	req := fetchRequest{deepen: -1}
	packets, _ := decodePktLines(body)
	for _, p := range packets {
		if p.Kind != PktData {
			continue
		}
		line := strings.TrimSpace(string(p.Payload))
		if nul := strings.IndexByte(line, 0); nul >= 0 {
			line = line[:nul]
		}
		switch {
		case strings.HasPrefix(line, "want "):
			req.wants = append(req.wants, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "have "):
			req.haves = append(req.haves, strings.TrimSpace(line[5:]))
		case strings.HasPrefix(line, "shallow "):
			req.shallows = append(req.shallows, strings.TrimSpace(line[8:]))
		case strings.HasPrefix(line, "deepen "):
			var n int
			fmt.Sscanf(line[7:], "%d", &n)
			req.deepen = n
		}
	}
	return req
}

type fetchPlan struct {
	pack      []byte
	shallow   []string
	unshallow []string
}

// planFetch computes the objects a fetch must deliver and the shallow
// boundary it reports.
func planFetch(store *Store, req fetchRequest) (*fetchPlan, error) {
	lookup := store.Lookup
	var roots []string
	var tagObjects []string
	for _, want := range req.wants {
		obj := lookup(want)
		if obj == nil {
			return nil, fmt.Errorf("want %s is not in the store", want)
		}
		if obj.Type == ObjTag {
			tagObjects = append(tagObjects, want)
			roots = append(roots, parseTag(obj.Data).Object)
		} else if obj.Type == ObjCommit {
			roots = append(roots, want)
		}
	}
	shallowSet := map[string]bool{}
	for _, s := range req.shallows {
		shallowSet[s] = true
	}
	// What the client already has: the closure of its haves, except that a
	// shallow commit's parents are NOT in its possession (a shallow clone
	// holds the boundary commit but none of its history).
	haveSet := map[string]bool{}
	for _, h := range req.haves {
		if set, err := collectReachable([]string{h}, lookup); err == nil {
			for oid := range set {
				haveSet[oid] = true
			}
		}
	}
	shallowCut := map[string]bool{}
	for _, s := range req.shallows {
		if obj := lookup(s); obj != nil && obj.Type == ObjCommit {
			for _, p := range parseCommit(obj.Data).Parents {
				if set, err := collectReachable([]string{p}, lookup); err == nil {
					for oid := range set {
						shallowCut[oid] = true
					}
				}
			}
		}
	}
	possessed := func(oid string) bool { return haveSet[oid] && !shallowCut[oid] }
	// Included commits: BFS from roots, bounded by depth, minus the haves
	// closure. Traversal continues through shallow haves (their parents are
	// not had) but stops at a fully-possessed commit.
	depth := -1
	if req.deepen >= 0 {
		depth = req.deepen
	}
	included := map[string]int{}
	type queueItem struct {
		oid string
		gen int
	}
	queue := []queueItem{}
	for _, r := range roots {
		queue = append(queue, queueItem{r, 0})
	}
	seenGen := map[string]int{}
	for len(queue) > 0 {
		item := queue[0]
		queue = queue[1:]
		oid, gen := item.oid, item.gen
		if g, ok := seenGen[oid]; ok && g <= gen {
			continue
		}
		seenGen[oid] = gen
		obj := lookup(oid)
		if obj == nil || obj.Type != ObjCommit {
			continue
		}
		if possessed(oid) && !shallowSet[oid] {
			continue
		}
		if !possessed(oid) {
			included[oid] = gen
		}
		if depth < 0 || gen+1 < depth {
			for _, p := range parseCommit(obj.Data).Parents {
				queue = append(queue, queueItem{p, gen + 1})
			}
		}
	}
	// Shallow: included commits whose parents were not included because of depth.
	var shallow []string
	if req.deepen >= 0 {
		for oid, gen := range included {
			if gen+1 >= depth {
				shallow = append(shallow, oid)
			}
		}
		sort.Strings(shallow)
	}
	// Unshallow: a client-shallow commit whose parents are now all included.
	var unshallow []string
	for _, s := range req.shallows {
		obj := lookup(s)
		if obj == nil || obj.Type != ObjCommit {
			continue
		}
		parents := parseCommit(obj.Data).Parents
		allIncluded := true
		for _, p := range parents {
			if _, ok := included[p]; !ok {
				allIncluded = false
				break
			}
		}
		if len(parents) == 0 || allIncluded {
			unshallow = append(unshallow, s)
		}
	}
	// Objects: tag objects + each included commit and its tree closure, minus
	// what the client actually holds.
	objectOIDs := map[string]bool{}
	for _, t := range tagObjects {
		objectOIDs[t] = true
	}
	for oid := range included {
		objectOIDs[oid] = true
		if obj := lookup(oid); obj != nil && obj.Type == ObjCommit {
			tree := parseCommit(obj.Data).Tree
			tqueue := []string{tree}
			for len(tqueue) > 0 {
				t := tqueue[len(tqueue)-1]
				tqueue = tqueue[:len(tqueue)-1]
				if objectOIDs[t] {
					continue
				}
				tobj := lookup(t)
				if tobj == nil {
					continue
				}
				objectOIDs[t] = true
				if tobj.Type == ObjTree {
					if entries, err := parseTree(tobj.Data); err == nil {
						for _, e := range entries {
							tqueue = append(tqueue, e.OID)
						}
					}
				}
			}
		}
	}
	for h := range haveSet {
		// Only delete objects the client actually holds: a shallow commit's
		// ancestors are in its closure but were never delivered to it.
		if !shallowCut[h] {
			delete(objectOIDs, h)
		}
	}
	var oids []string
	for oid := range objectOIDs {
		oids = append(oids, oid)
	}
	sort.Strings(oids)
	objects := make([]*GitObject, 0, len(oids))
	for _, oid := range oids {
		if obj := lookup(oid); obj != nil {
			objects = append(objects, obj)
		}
	}
	return &fetchPlan{pack: writePack(objects), shallow: shallow, unshallow: unshallow}, nil
}

func sidebandPackets(pack []byte) [][]byte {
	var out [][]byte
	const chunk = 65500
	for off := 0; off < len(pack); off += chunk {
		end := off + chunk
		if end > len(pack) {
			end = len(pack)
		}
		framed := make([]byte, 1+end-off)
		framed[0] = 1
		copy(framed[1:], pack[off:end])
		out = append(out, pktLine(framed))
	}
	return out
}

func buildFetchV2Response(store *Store, repo *Repo, req fetchRequest) ([]byte, error) {
	cacheKey := strings.Join(req.wants, ",") + "|" + strings.Join(req.haves, ",") + "|" +
		strings.Join(req.shallows, ",") + "|" + fmt.Sprintf("%d", req.deepen)
	if repo.packRev == repo.Rev {
		if cached, ok := repo.packCache[cacheKey]; ok {
			return cached, nil
		}
	} else {
		repo.packCache = map[string][]byte{}
		repo.packRev = repo.Rev
	}
	plan, err := planFetch(store, req)
	if err != nil {
		return nil, err
	}
	var parts [][]byte
	allHavesKnown := len(req.haves) > 0
	for _, h := range req.haves {
		if _, ok := store.Objects[h]; !ok {
			allHavesKnown = false
			break
		}
	}
	parts = append(parts, pktLineString("acknowledgments\n"))
	if allHavesKnown {
		parts = append(parts, pktLineString("ACK "+req.haves[0]+"\n"))
	} else {
		parts = append(parts, pktLineString("NAK\n"))
	}
	parts = append(parts, pktDelim)
	if len(plan.shallow) > 0 || len(plan.unshallow) > 0 {
		parts = append(parts, pktLineString("shallow-info\n"))
		for _, s := range plan.shallow {
			parts = append(parts, pktLineString("shallow "+s+"\n"))
		}
		for _, s := range plan.unshallow {
			parts = append(parts, pktLineString("unshallow "+s+"\n"))
		}
		parts = append(parts, pktDelim)
	}
	parts = append(parts, pktLineString("packfile\n"))
	parts = append(parts, sidebandPackets(plan.pack)...)
	parts = append(parts, pktFlush)
	buf := pktLines(parts)
	repo.packCache[cacheKey] = buf
	return buf, nil
}

func buildFetchV0Response(store *Store, req fetchRequest) ([]byte, error) {
	plan, err := planFetch(store, req)
	if err != nil {
		return nil, err
	}
	var parts [][]byte
	allHavesKnown := len(req.haves) > 0
	for _, h := range req.haves {
		if _, ok := store.Objects[h]; !ok {
			allHavesKnown = false
			break
		}
	}
	if allHavesKnown {
		parts = append(parts, pktLineString("ACK "+req.haves[0]+"\n"))
	} else {
		parts = append(parts, pktLineString("NAK\n"))
	}
	for _, s := range plan.shallow {
		parts = append(parts, pktLineString("shallow "+s+"\n"))
	}
	for _, s := range plan.unshallow {
		parts = append(parts, pktLineString("unshallow "+s+"\n"))
	}
	parts = append(parts, sidebandPackets(plan.pack)...)
	parts = append(parts, pktFlush)
	return pktLines(parts), nil
}

// handleUploadPack serves POST /{owner}/{repo}.git/git-upload-pack
// (v2 command or v0 fetch).
func handleUploadPack(c *Ctx) {
	repo := resolveGitRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	body, err := readBody(c)
	if err != nil {
		sendError(c, 400, "cannot read body")
		return
	}
	v2 := strings.Contains(header(c, "Git-Protocol"), "version=2")
	if v2 {
		text := string(body)
		if strings.Contains(text, "command=ls-refs") {
			buf := buildLsRefs(c.Store, repo, parseLsRefsBody(body))
			sendRaw(c, 200, "application/x-git-upload-pack-result", buf)
			return
		}
		if !strings.Contains(text, "command=fetch") {
			sendError(c, 400, "unknown git v2 command")
			return
		}
		buf, err := buildFetchV2Response(c.Store, repo, parseFetchV2(body))
		if err != nil {
			sendError(c, 400, err.Error())
			return
		}
		sendRaw(c, 200, "application/x-git-upload-pack-result", buf)
		return
	}
	buf, err := buildFetchV0Response(c.Store, parseFetchV0(body))
	if err != nil {
		sendError(c, 400, err.Error())
		return
	}
	sendRaw(c, 200, "application/x-git-upload-pack-result", buf)
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

type pushCommand struct {
	oldOID string
	newOID string
	ref    string
}

func parseReceivePack(body []byte) (commands []pushCommand, pack []byte, err error) {
	packets, rest := decodePktLines(body)
	for _, p := range packets {
		if p.Kind != PktData {
			continue
		}
		line := strings.TrimSpace(string(p.Payload))
		if nul := strings.IndexByte(line, 0); nul >= 0 {
			line = line[:nul]
		}
		parts := strings.Split(line, " ")
		if len(parts) < 3 {
			return nil, nil, fmt.Errorf("malformed push command")
		}
		oldOID, newOID, ref := parts[0], parts[1], parts[2]
		if !isObjectID(oldOID) || !isObjectID(newOID) || !strings.HasPrefix(ref, "refs/") {
			return nil, nil, fmt.Errorf("malformed push command")
		}
		commands = append(commands, pushCommand{oldOID, newOID, ref})
	}
	if len(commands) == 0 {
		return nil, nil, fmt.Errorf("no push commands")
	}
	return commands, rest, nil
}

// handleReceivePack serves POST /{owner}/{repo}.git/git-receive-pack
func handleReceivePack(c *Ctx) {
	repo := resolveGitRepo(c)
	if repo == nil {
		sendError(c, 404, "repository not found")
		return
	}
	body, err := readBody(c)
	if err != nil {
		sendError(c, 400, "cannot read body")
		return
	}
	commands, pack, err := parseReceivePack(body)
	if err != nil {
		sendError(c, 400, err.Error())
		return
	}
	if len(pack) > 0 {
		pr, err := readPack(pack, c.Store.Lookup)
		if err != nil {
			sendError(c, 400, err.Error())
			return
		}
		for oid, obj := range pr.Objects {
			c.Store.PutObjectWithID(oid, obj)
		}
	}
	var lines []string
	lines = append(lines, "unpack ok")
	changed := false
	for _, cmd := range commands {
		current, exists := repo.Refs[cmd.ref]
		ok := false
		reason := ""
		switch {
		case cmd.newOID == ZeroOID:
			if exists {
				delete(repo.Refs, cmd.ref)
				ok = true
			} else {
				reason = "remote ref does not exist"
			}
		case cmd.oldOID == ZeroOID:
			if !exists {
				repo.Refs[cmd.ref] = cmd.newOID
				ok = true
			} else {
				reason = "remote ref already exists"
			}
		case !exists:
			reason = "remote ref does not exist"
		case current != cmd.oldOID:
			reason = "non-fast-forward"
		case !FastForwardOK(c.Store, cmd.oldOID, cmd.newOID):
			reason = "non-fast-forward"
		default:
			repo.Refs[cmd.ref] = cmd.newOID
			ok = true
		}
		if ok {
			changed = true
			lines = append(lines, "ok "+cmd.ref)
		} else {
			if reason == "" {
				reason = "non-fast-forward"
			}
			lines = append(lines, "ng "+cmd.ref+" "+reason)
		}
	}
	if changed {
		repo.Rev++
		repo.repoJSONBuf = nil
	}
	var parts [][]byte
	for _, line := range lines {
		framed := append([]byte{1}, []byte(line+"\n")...)
		parts = append(parts, pktLine(framed))
	}
	parts = append(parts, pktFlush)
	sendRaw(c, 200, "application/x-git-receive-pack-result", pktLines(parts))
}
