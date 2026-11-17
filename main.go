// main.go — the forge entry point: one process, one Go HTTP server.
// Trial mode (MAKEFUN_ENV_URL set): bind an ephemeral port, register it with
// the environment, serve until the environment reports done, then exit 0.
// Standalone mode (no MAKEFUN_ENV_URL): serve forever on $PORT (default 8123).

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

func route(method, pattern string, handler func(c *Ctx)) Route {
	return Route{Method: method, Pattern: regexp.MustCompile(pattern), Handler: handler}
}

func routes() []Route {
	return []Route{
		// Health (the environment probes this twice).
		route("GET", `^/healthz$`, func(c *Ctx) { sendJSON(c, 200, map[string]any{"ok": true}, nil) }),
		// Hot paths first: the benchmark hammers these routes.
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/issues/(\d+)$`, handleGetIssue),
		route("POST", `^/([^/]+)/([^/]+)\.git/git-receive-pack$`, handleReceivePack),
		route("POST", `^/([^/]+)/([^/]+)\.git/git-upload-pack$`, handleUploadPack),
		route("GET", `^/([^/]+)/([^/]+)\.git/info/refs$`, handleInfoRefs),
		route("POST", `^/api/v3/repos/([^/]+)/([^/]+)/issues$`, handleCreateIssue),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)$`, handleGetRepo),
		// GraphQL v4 and MCP.
		route("POST", `^/api/graphql$`, handleGraphQL),
		route("POST", `^/mcp$`, handleMcp),
		// REST v3 (remaining).
		route("GET", `^/api/v3/$`, handleRoot),
		route("GET", `^/api/v3/meta$`, handleMeta),
		route("GET", `^/api/v3/user$`, handleGetUser),
		route("GET", `^/api/v3/user/repos$`, handleListUserRepos),
		route("POST", `^/api/v3/user/repos$`, handleCreateUserRepo),
		route("PATCH", `^/api/v3/repos/([^/]+)/([^/]+)$`, handlePatchRepo),
		route("DELETE", `^/api/v3/repos/([^/]+)/([^/]+)$`, handleDeleteRepo),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/branches$`, handleListBranches),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/branches/(.+)$`, handleGetBranch),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/commits$`, handleListCommits),
		route("POST", `^/api/v3/repos/([^/]+)/([^/]+)/git/refs$`, handleCreateRef),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/git/refs/heads/(.+)$`, handleGetRef),
		route("PUT", `^/api/v3/repos/([^/]+)/([^/]+)/contents/(.+)$`, handlePutContents),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/contents$`, handleGetContents),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/contents/(.+)$`, handleGetContents),
		route("DELETE", `^/api/v3/repos/([^/]+)/([^/]+)/contents/(.+)$`, handleDeleteContents),
		route("POST", `^/api/v3/repos/([^/]+)/([^/]+)/labels$`, handleCreateLabel),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/labels$`, handleListLabels),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/issues$`, handleListIssues),
		route("PATCH", `^/api/v3/repos/([^/]+)/([^/]+)/issues/(\d+)$`, handlePatchIssue),
		route("POST", `^/api/v3/repos/([^/]+)/([^/]+)/issues/(\d+)/comments$`, handleCreateComment),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/issues/(\d+)/comments$`, handleListComments),
		route("POST", `^/api/v3/repos/([^/]+)/([^/]+)/pulls$`, handleCreatePull),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/pulls$`, handleListPulls),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/pulls/(\d+)$`, handleGetPull),
		route("GET", `^/api/v3/repos/([^/]+)/([^/]+)/pulls/(\d+)/files$`, handleListPullFiles),
		route("PUT", `^/api/v3/repos/([^/]+)/([^/]+)/pulls/(\d+)/merge$`, handleMergePull),
	}
}

func fallback(c *Ctx) {
	sendJSON(c, 404, map[string]any{"message": "not found"}, nil)
}

func runTrial(envURL string, port int) {
	base := strings.TrimSuffix(envURL, "/")
	client := &http.Client{Timeout: 5 * time.Second}
	registered := false
	for attempt := 0; attempt < 30 && !registered; attempt++ {
		body, _ := json.Marshal(map[string]any{"port": port})
		req, err := http.NewRequest("POST", base+"/register", bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			resp, err := client.Do(req)
			if err == nil {
				resp.Body.Close()
				if resp.StatusCode >= 200 && resp.StatusCode < 300 {
					registered = true
				}
			}
		}
		if !registered {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if !registered {
		fmt.Fprintln(os.Stderr, "forge: could not register with the environment")
		os.Exit(1)
	}
	for {
		time.Sleep(250 * time.Millisecond)
		resp, err := client.Get(base + "/done")
		if err != nil {
			continue
		}
		var data map[string]any
		json.NewDecoder(resp.Body).Decode(&data)
		resp.Body.Close()
		if done, _ := data["done"].(bool); done {
			return
		}
	}
}

func main() {
	store := NewStore()
	allRoutes := routes()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dispatch(allRoutes, fallback, store, w, r)
	})
	server := &http.Server{Handler: handler}

	envURL := os.Getenv("MAKEFUN_ENV_URL")
	if envURL != "" {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fmt.Fprintln(os.Stderr, "forge: listen:", err)
			os.Exit(1)
		}
		port := ln.Addr().(*net.TCPAddr).Port
		go func() {
			if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
				fmt.Fprintln(os.Stderr, "forge: serve:", err)
			}
		}()
		runTrial(envURL, port)
		server.Close()
		os.Exit(0)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8123"
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		fmt.Fprintln(os.Stderr, "forge: listen:", err)
		os.Exit(1)
	}
	fmt.Printf("forge listening on http://127.0.0.1:%s\n", port)
	if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, "forge: serve:", err)
		os.Exit(1)
	}
}
